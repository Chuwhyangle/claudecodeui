/**
 * The user's own DashScope credential, from the settings document to the wire — and back.
 *
 * WHAT THIS FILE IS FOR. A recogniser whose transport is `proxy-only` cannot be reached by the
 * browser, so its address and key have to live on the server and the server has to present them
 * upstream. That makes three questions answerable only here:
 *
 *   1. WHICH provider is configured — asked per provider, not once for the whole link, because a
 *      provider reached with the USER's pair is not configured by the deployment's backend at all;
 *   2. WHERE the credential may appear — in the stored document and on the outbound request, never
 *      in a readback and never in a log line;
 *   3. WHICH credential each path uses — the transcription path must present the user's pair while
 *      TTS keeps presenting the deployment's, unchanged.
 *
 * The readings below are the measurements of those three, taken through the SHIPPING service, the
 * SHIPPING router and a real SQLite file in a temp directory. The upstream is an injected stub and
 * the log port is an injected collector, so nothing here touches the network or a real account
 * (ADR-004 decision 8: the live smoke is a human step).
 *
 * HOW IT IS STRUCTURED, and why this matters to a reader of the red: the readings live in one
 * exported function so that the FALSIFYING file (`voice-dashscope-settings.false-forms.test.ts`) can
 * run this very list against a text-mutated copy of `voice.service.ts` and require the specific
 * readings it predicts to go red. Registering them as `node:test` cases is guarded by `IS_ENTRY`,
 * so importing this file registers nothing and the falsify run measures only what it asked for.
 *
 * THE ENVIRONMENT IS CLEARED BEFORE ANY SHIPPED MODULE IS IMPORTED, in the module body rather than
 * in a hook, because a hook runs after the imports it would be protecting against: AC2's whole
 * subject is the link a deployment with no voice environment and no user document has, so the
 * variables have to be gone before `voice.module.ts`'s own defaults could be read from them. Every
 * shipped module below is therefore imported dynamically, after the loop.
 */

import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `AsrAdapter` comes from the registry rather than from `@/shared/types.js`: that module imports the
// type for its own comments and does not re-export it, and the declaration this file reads the
// credential fields off is the registry's — importing it from where it is declared is what keeps the
// "one copy" claim below a statement about the same module the server reads.
import type { AsrAdapter } from '../../../../shared/asr/asrRegistry.js';
import type {
  VoiceHealth,
  VoiceLogPort,
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettings,
  VoiceSettingsService,
  VoiceSettingsStore,
} from '@/shared/types.js';

// ── AC2: the environment is emptied before the first shipped import ───────────────────────────

/**
 * Every variable the voice composition root reads, removed before anything it configures is loaded.
 *
 * The list is the module's own vocabulary (`voice.module.ts` reads exactly these seven), written out
 * rather than derived, because a criterion that asked the module which variables it reads would be
 * asking the code under test what to test.
 */
const CLEARED_ENV_VARS = [
  'VOICE_API_BASE_URL',
  'VOICE_API_KEY',
  'VOICE_PROVIDER_ID',
  'VOICE_STT_MODEL',
  'VOICE_TTS_MODEL',
  'VOICE_TTS_VOICE',
  'VOICE_TIMEOUT_MS',
] as const;

for (const name of CLEARED_ENV_VARS) {
  delete process.env[name];
}
// The same courtesy `voice-config.routes.test.ts` pays `shared/utils.ts`, which freezes this flag on
// first import: set, it replaces token checks with "the first database user". This file attaches the
// authenticated user itself, so the flag would only be a second, invisible identity source.
delete process.env.VITE_IS_PLATFORM;

/** Captured before anything runs, so "the shipping code patched `console`" is decidable later. */
const ORIGINAL_CONSOLE_INFO = console.info;

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading is a red, not a shorter list. */
const READINGS_EXPECTED = 30;

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — one level above `modules/`, three above this file. */
const SERVER_DIR = path.resolve(HERE, '../../..');
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** The shipping service module: what the readings import by default, and what the mutants copy. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The directory the module lives in — the one a sibling criterion writes its temp copies into. */
const VOICE_MODULE_DIR = path.dirname(SHIPPING_SERVICE_MODULE);
const SHIPPING_ROUTES_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.routes.ts');
const VOICE_SETTINGS_DB_MODULE = path.join(SERVER_DIR, 'modules/database/repositories/voice-settings.db.ts');
const DB_CONNECTION_MODULE = path.join(SERVER_DIR, 'modules/database/core/index.ts');
const DB_INIT_MODULE = path.join(SERVER_DIR, 'modules/database/init-db.ts');
const REGISTRY_MODULE = path.join(REPO_ROOT, 'shared/asr/asrRegistry.ts');
const DASHSCOPE_MODULE = path.join(REPO_ROOT, 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts');

// ── the fixtures ─────────────────────────────────────────────────────────────────────────────

/** The user's workspace endpoint: a legal address under the provider's own rule. */
const DASHSCOPE_ENDPOINT = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';
/** The credential the SERVER holds and presents upstream. Never printed whole by this file. */
const DASHSCOPE_KEY = 'sk-dashscope-sentinel';
/** The pair the browser keeps for its own direct path (AC-140's path), and TTS's pair. */
const BROWSER_BASE_URL = 'https://api.groq.com/openai/v1';
const BROWSER_API_KEY = 'sk-sentinel-voice-backend-key';

/** The mask a stored credential reads back as — the wire's value, not the module's constant. */
const CREDENTIAL_MASK = '••••••••';

/** The recording, and the base64 the adapter would put on the wire for it. */
const AUDIO_BYTES = Buffer.from('criterion recording bytes 5c9d', 'utf8');
const AUDIO_BASE64 = AUDIO_BYTES.toString('base64');

/** Two texts that exist nowhere else, so "the log does not carry them" is a discrimination. */
const SUCCESS_TRANSCRIPT = 'criterion transcript sentinel 3f6a';
const SUCCESS_INSTRUCTION = 'criterion instruction sentinel 91b2';

const SUCCESS_ANSWER = JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ transcript: SUCCESS_TRANSCRIPT, instruction: SUCCESS_INSTRUCTION }) } }],
});

/** The defaults `voice.module.ts` builds with no environment at all: empty pair, factory models. */
const ENV_CLEAN_DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** The deployment's own backend, for the one path that must keep using it (AC6). */
const DEPLOYMENT_DEFAULTS = {
  ...ENV_CLEAN_DEFAULTS,
  baseUrl: BROWSER_BASE_URL,
  apiKey: BROWSER_API_KEY,
};

const TIMEOUT_MS = 5_000;

/**
 * The document AC3 saves: the four provider-owned fields plus the six shared ones, all ten present.
 *
 * The two shared fields that decide `configured` are EMPTY on purpose — that is the positive control
 * AC3 (a) turns on: a server with no backend and a user whose only filled pair is the provider's must
 * report that provider as configured and every other one as not.
 */
const SAVED_DOCUMENT: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: 'whisper-large-v3',
  ttsModel: 'playai-tts',
  ttsVoice: 'Arista-PlayAI',
  ttsFormat: 'mp3',
  providerId: 'dashscope-omni',
  dashscopeEndpoint: DASHSCOPE_ENDPOINT,
  dashscopeApiKey: DASHSCOPE_KEY,
  dashscopeModel: '',
};

/** AC3 (b): the other direction — the shared pair filled, the provider's fields untouched. */
const SHARED_ONLY_DOCUMENT: VoiceSettings = {
  ...SAVED_DOCUMENT,
  baseUrl: BROWSER_BASE_URL,
  apiKey: BROWSER_API_KEY,
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
};

// ── the harness ──────────────────────────────────────────────────────────────────────────────

/** The router as this file calls it: express hands `Router` out as a callable, and so does this. */
type RouterLike = (request: unknown, response: unknown, next: (error?: unknown) => void) => unknown;

type RouterOutcome = {
  status: number;
  body: unknown;
  /** True once a handler answered; a route that never matched is a red rather than a hang. */
  finished: boolean;
  error?: unknown;
};

type RequestDouble = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  user?: { id?: number };
  file?: { buffer: Buffer; mimetype: string; originalname: string };
};

type UpstreamCall = { url: string; headers: Record<string, string>; bodyText: string };
type UpstreamAnswer = { status: number; body: string; contentType?: string };

type ServiceDeps = {
  defaults: typeof ENV_CLEAN_DEFAULTS;
  timeoutMs: number;
  fetchBackend: (url: string, options: RequestInit) => Promise<Response>;
  logger?: VoiceLogPort;
};

type ServiceModule = {
  createVoiceService: (dependencies: ServiceDeps) => VoiceService;
  createVoiceSettingsService: (store: VoiceSettingsStore) => VoiceSettingsService;
};

type RouterModule = {
  createVoiceRouter: (dependencies: {
    voiceService: VoiceService;
    voiceSettingsService: VoiceSettingsService;
    parseAudioUpload: (request: unknown, response: unknown, callback: (error?: unknown) => void) => void;
  }) => RouterLike;
};

type DatabaseModule = {
  initializeDatabase: () => Promise<void> | void;
  closeConnection: () => void;
  getConnection: () => { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
};

type BuildOptions = { logger?: VoiceLogPort; defaults?: typeof ENV_CLEAN_DEFAULTS };

type Rig = {
  modulePath: string;
  service: VoiceService;
  settingsService: VoiceSettingsService;
  router: RouterLike;
  logLines: string[];
  upstream: {
    calls: UpstreamCall[];
    fetchBackend: (url: string, options: RequestInit) => Promise<Response>;
    respondWith: (handler: (call: UpstreamCall) => UpstreamAnswer) => void;
  };
  buildService: (options?: BuildOptions) => VoiceService;
  health: (settings: VoiceSettings) => VoiceServiceResult<VoiceHealth>;
  transcribe: (
    settings: VoiceSettings,
    overrides?: VoiceRequestOverrides,
  ) => Promise<VoiceServiceResult<{ text: string }>>;
  get: (user?: number) => Promise<RouterOutcome>;
  put: (body: unknown, user?: number) => Promise<RouterOutcome>;
  readStored: (user?: number) => VoiceSettings;
  close: () => Promise<void>;
  savedPut?: RouterOutcome;
  controlPut?: RouterOutcome;
  emptyPut?: RouterOutcome;
  emptyGet?: RouterOutcome;
  wired?: {
    authorization?: string;
    result?: VoiceServiceResult<{ text: string }>;
  };
  logged?: {
    ok: VoiceServiceResult<{ text: string }>;
    fail: VoiceServiceResult<{ text: string }>;
    authorization?: string;
  };
  tts?: UpstreamCall;
};

/**
 * Answers a request the way an express handler does, so the shipping router can be driven without a
 * listening socket.
 *
 * The `next` argument is what keeps a mis-routed call a RED rather than a hang: express calls it when
 * no route matched, and without a settle there the await below would never return — the shape that
 * a criterion's own timeout then reports as "the criterion hung", naming nothing.
 */
function createResponseDouble(): {
  response: unknown;
  outcome: RouterOutcome;
  settled: Promise<void>;
  /** Settles `settled` from outside the handlers — the `next` path reads a response that never answered. */
  settle: () => void;
} {
  const outcome: RouterOutcome = { status: 200, body: undefined, finished: false };
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const self = {
    status(code: number) {
      outcome.status = code;
      return self;
    },
    json(payload: unknown) {
      outcome.body = payload;
      outcome.finished = true;
      settle();
      return self;
    },
    end() {
      outcome.finished = true;
      settle();
      return self;
    },
    setHeader() {
      return self;
    },
    destroy() {},
  };

  return { response: self, outcome, settled, settle };
}

async function callRouter(
  router: RouterLike,
  call: { method: string; url: string; body?: unknown; user?: number },
): Promise<RouterOutcome> {
  const { response, outcome, settled, settle } = createResponseDouble();
  // The authenticated user is attached here rather than by a middleware: `authenticateToken` is
  // pinned by `voice-config.routes.test.ts`, and what these readings need is the identity the
  // router reads (`request.user.id`) without a second JWT implementation in this file.
  const request: RequestDouble = {
    method: call.method,
    url: call.url,
    headers: {},
    body: call.body,
    user: { id: call.user ?? 1 },
  };

  router(request, response, (error?: unknown) => {
    outcome.error = error;
    settle();
  });

  await settled;
  return outcome;
}

/** The upload parser stand-in: one webm in `request.file`, exactly as multer would leave it. */
function parseAudioUpload(
  request: unknown,
  _response: unknown,
  callback: (error?: unknown) => void,
): void {
  const target = request as RequestDouble;
  target.file = { buffer: AUDIO_BYTES, mimetype: 'audio/webm', originalname: 'recording.webm' };
  callback();
}

/** Reads a Response's headers into a lowercase map, so a header lookup is not case-sensitive. */
function readHeaderMap(options: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = options.headers;
  if (raw === undefined) {
    return headers;
  }
  const entries = raw instanceof Headers ? [...raw.entries()] : Object.entries(raw as Record<string, string>);
  for (const [name, value] of entries) {
    headers[name.toLowerCase()] = String(value);
  }
  return headers;
}

/**
 * Opens one measurement session: a temp SQLite file with three users, a service built from
 * `serviceModulePath`, the shipping router over it, and a stub upstream.
 *
 * The database is a REAL file and the repository is the shipping one, because two of the properties
 * under test are about storage: a field the writer's list drops is dropped on the way back out, and
 * the mask must be a readback face rather than a filter on the way in. An in-memory fake would make
 * both of those true by construction.
 */
async function openRig(serviceModulePath: string): Promise<Rig> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-dashscope-criterion-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  const database = (await import(pathToFileURL(DB_CONNECTION_MODULE).href)) as unknown as DatabaseModule;
  const initDb = (await import(pathToFileURL(DB_INIT_MODULE).href)) as unknown as Pick<
    DatabaseModule,
    'initializeDatabase'
  >;
  const settingsDb = (await import(pathToFileURL(VOICE_SETTINGS_DB_MODULE).href)) as unknown as {
    voiceSettingsDb: VoiceSettingsStore;
  };

  database.closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'criterion.db');
  await initDb.initializeDatabase();

  for (const id of [1, 2, 3]) {
    database
      .getConnection()
      .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(id, `criterion-${id}`, 'hash');
  }

  const serviceModule = (await import(pathToFileURL(serviceModulePath).href)) as unknown as ServiceModule;
  const routesModule = (await import(pathToFileURL(SHIPPING_ROUTES_MODULE).href)) as unknown as RouterModule;

  const logLines: string[] = [];
  const upstreamCalls: UpstreamCall[] = [];
  let respond: (call: UpstreamCall) => UpstreamAnswer = () => ({
    status: 200,
    body: SUCCESS_ANSWER,
    contentType: 'application/json',
  });

  const fetchBackend = async (url: string, options: RequestInit): Promise<Response> => {
    const call: UpstreamCall = {
      url,
      headers: readHeaderMap(options),
      bodyText: typeof options.body === 'string' ? options.body : '',
    };
    upstreamCalls.push(call);
    const answer = respond(call);
    return new Response(answer.body, {
      status: answer.status,
      headers: answer.contentType === undefined ? {} : { 'content-type': answer.contentType },
    });
  };

  const buildService = (options: BuildOptions = {}): VoiceService => {
    const dependencies: ServiceDeps = {
      defaults: options.defaults ?? ENV_CLEAN_DEFAULTS,
      timeoutMs: TIMEOUT_MS,
      fetchBackend,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    };
    return serviceModule.createVoiceService(dependencies);
  };

  const logPort: VoiceLogPort = {
    info: (message) => {
      logLines.push(message);
    },
  };

  const service = buildService({ logger: logPort });
  const settingsService = serviceModule.createVoiceSettingsService(settingsDb.voiceSettingsDb);
  const router = routesModule.createVoiceRouter({
    voiceService: service,
    voiceSettingsService: settingsService,
    parseAudioUpload,
  });

  const rig: Rig = {
    modulePath: serviceModulePath,
    service,
    settingsService,
    router,
    logLines,
    upstream: {
      calls: upstreamCalls,
      fetchBackend,
      respondWith: (handler) => {
        respond = handler;
      },
    },
    buildService,
    health: (settings) => service.getHealth({ settings }),
    transcribe: (settings, overrides = {}) =>
      service.transcribe({
        audio: { bytes: AUDIO_BYTES, mimeType: 'audio/webm', fileName: 'recording.webm' },
        overrides,
        settings,
      }),
    get: (user = 1) => callRouter(router, { method: 'GET', url: '/config', user }),
    put: (body, user = 1) => callRouter(router, { method: 'PUT', url: '/config', body, user }),
    readStored: (user = 1) => settingsDb.voiceSettingsDb.getSettings(user),
    close: async () => {
      database.closeConnection();
      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }
      await rm(tempDirectory, { recursive: true, force: true });
    },
  };

  return rig;
}

/** The JSON body of a router outcome, or an empty object when the call did not answer. */
function bodyOf(outcome: RouterOutcome | undefined): Record<string, unknown> {
  if (outcome === undefined || typeof outcome.body !== 'object' || outcome.body === null) {
    return {};
  }
  return outcome.body as Record<string, unknown>;
}

function stringOf(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** A shape that identifies a secret without disclosing it: length plus its first two characters. */
function describeSecret(value: string): string {
  if (value === '') {
    return 'len=0';
  }
  return `len=${value.length} head=${value.slice(0, 2)}…`;
}

function jsonParseOrNull(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The name prefix the sibling falsify criteria give the temp copies they write INTO THIS DIRECTORY.
 *
 * `voice-capture-off`, `voice-capture-text` and `voice-dashscope-settings` each copy a shipping
 * module to `server/modules/voice/__criterion-falsify-<mutation>-{base,mut}-<pid>.ts`, drive the
 * readings against the copy, and delete it in a `finally`. Those copies are not product source and
 * they are not this criterion's business — they are this SUITE's scratch space, and `scripts/test.sh`
 * runs four files at a time, so one can appear and disappear inside a single scan below.
 */
const TEMP_COPY_PREFIX = '__criterion-falsify-';

/**
 * The AC4(b) positive control's file name is `<prefix><pid>.ts`. Several processes run this file
 * against ONE tree at once — the suite runs it directly, and each `voice-capture-*.false-forms`
 * AC10 runs it again as a nested criterion — so a plain shared name let one process's control show
 * up as a shipping hit in another's scan, and let one process's cleanup delete another's control.
 */
const STRAY_PROBE_PREFIX = '__stray-shipping-probe-';

/** Whether a file is a positive control planted by a DIFFERENT process; the scan must not see it. */
function isForeignStrayProbe(name: string): boolean {
  const match = new RegExp(`^${STRAY_PROBE_PREFIX}(\\d+)\\.ts$`).exec(name);
  return match !== null && Number(match[1]) !== process.pid;
}

/**
 * Every `.ts` file under `directory`. Dependency trees are skipped; `tests/` directories are not.
 *
 * A SIBLING CRITERION'S IN-FLIGHT TEMP COPY IS NOT COLLECTED, and that exclusion is what makes the
 * scan a measurement rather than a race. Two things went wrong without it, and they are the same
 * fault seen from two sides:
 *
 *   · the file set followed a neighbour's timing, so `files=` counted a file that has nothing to do
 *     with the product tree and moved between two runs of the same reading;
 *   · `readdir` and `readFile` are two different syscalls a neighbour's `rm` can land between, so a
 *     copy that was collected and then deleted produced an `ENOENT` — which `collectReadings` reports
 *     as `ok=false` with the failure's message, indistinguishable in shape from a real hit.
 *
 * Excluded BY NAME, which is the property the copy carries from the instant it is created rather
 * than something a stat can race for. The other half of the exclusion — that a real occurrence in a
 * real product file is still found — is the AC4(b) case's positive control, registered below.
 */
async function collectSourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }
      found.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (
      entry.name.endsWith('.ts') &&
      !entry.name.startsWith(TEMP_COPY_PREFIX) &&
      !isForeignStrayProbe(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
}

/** Whether a path lives under a `tests/` directory. */
function isTestPath(file: string): boolean {
  return file.split(path.sep).includes('tests');
}

// ── the readings ─────────────────────────────────────────────────────────────────────────────

type Measured = { value: string; ok: boolean };
type Reading = { name: string; run: (rig: Rig) => Promise<Measured> | Measured };
type ReadingOutcome = { name: string; value: string; ok: boolean };

/** The provider-owned field names as the criterion drives them (its own copy, deliberately). */
const PROVIDER_FIELDS = ['providerId', 'dashscopeEndpoint', 'dashscopeApiKey', 'dashscopeModel'] as const;

/** The health payload's per-provider rows, as a printable `configured[id]=b` list. */
function configuredRows(health: VoiceServiceResult<VoiceHealth>): string {
  if (!health.ok) {
    return `unavailable(${health.status})`;
  }
  return health.value.providers.map((provider) => `configured[${provider.id}]=${provider.configured}`).join(',');
}

/** The configured flag for one provider id out of a health result, or `null` when absent. */
function configuredOf(health: VoiceServiceResult<VoiceHealth>, providerId: string): boolean | null {
  if (!health.ok) {
    return null;
  }
  const row = health.value.providers.find((provider) => provider.id === providerId);
  return row === undefined ? null : row.configured;
}

const READINGS: readonly Reading[] = [
  {
    // AC2's own precondition, asserted rather than assumed: a variable that was never set and one
    // this file deleted read the same in `process.env`, so "clean" has to be checked, not declared.
    name: 'AC2 env-clean',
    run: () => {
      const present = CLEARED_ENV_VARS.filter((name) => process.env[name] !== undefined);
      return { value: `env-clean=${present.length === 0} cleared=${CLEARED_ENV_VARS.join(',')}`, ok: present.length === 0 };
    },
  },
  {
    // The link a deployment with nothing configured and a user who has saved nothing has. The
    // provider that needs the USER's pair must read as unconfigured here — that is the reading a
    // single global boolean gets wrong in this direction.
    name: 'AC2 before[dashscope-omni]',
    run: async (rig) => {
      const health = rig.health(SAVED_DOCUMENT_EMPTY);
      const configured = configuredOf(health, 'dashscope-omni');
      return { value: `before[dashscope-omni]=${configured}`, ok: configured === false };
    },
  },
  {
    name: 'AC2 before[top]',
    run: async (rig) => {
      const health = rig.health(SAVED_DOCUMENT_EMPTY);
      const configured = health.ok ? health.value.configured : null;
      return { value: `before[top]=${configured}`, ok: configured === false };
    },
  },
  {
    // The save path itself: the shipping settings service behind the shipping router, writing a
    // real row. `declaredEndpointRefusal` runs here too — a provider's own rule asked at the moment
    // the address is stored, which is why the workspace address above has to be a legal one.
    name: 'AC3 save-and-readback',
    run: async (rig) => {
      const put: Rig['savedPut'] = await rig.put(SAVED_DOCUMENT, 1);
      rig.savedPut = put;
      const stored = rig.readStored(1);
      const held = PROVIDER_FIELDS.filter((field) => stored[field] === SAVED_DOCUMENT[field]).length;
      const ok = put.status === 200 && put.finished && held === PROVIDER_FIELDS.length;
      return { value: `put.status=${put.status} stored.held=${held}/${PROVIDER_FIELDS.length}`, ok };
    },
  },
  {
    // Per provider, on the document read back FROM STORAGE: the two directions of the control in one
    // line. A service computing one boolean for the whole link cannot produce this shape.
    name: 'AC3 configured-rows',
    run: async (rig) => {
      const health = rig.health(rig.readStored(1));
      const value = configuredRows(health);
      return { value, ok: configuredOf(health, 'dashscope-omni') === true };
    },
  },
  {
    name: 'AC3 top',
    run: async (rig) => {
      const health = rig.health(rig.readStored(1));
      const configured = health.ok ? health.value.configured : null;
      return { value: `top=${configured}`, ok: configured === true };
    },
  },
  {
    // The user's own choice outranks the deployment's default, which is empty here.
    name: 'AC3 provider',
    run: async (rig) => {
      const health = rig.health(rig.readStored(1));
      const provider = health.ok ? health.value.provider : null;
      return { value: `provider=${provider}`, ok: provider === 'dashscope-omni' };
    },
  },
  {
    // AC3 (a): the same document, the other provider. Only the provider's own pair is filled, so a
    // provider reached through the deployment's backend has nothing to reach it with.
    name: 'AC3 control-a openai-compatible',
    run: async (rig) => {
      const health = rig.health(rig.readStored(1));
      const configured = configuredOf(health, 'openai-compatible');
      return { value: `control-a configured[openai-compatible]=${configured}`, ok: configured === false };
    },
  },
  {
    // AC3 (b): the reverse document, stored for another user so the first user's document is not
    // disturbed. Same router, same service, opposite direction.
    name: 'AC3 control-b openai-compatible',
    run: async (rig) => {
      const put: Rig['controlPut'] = await rig.put(SHARED_ONLY_DOCUMENT, 2);
      rig.controlPut = put;
      const health = rig.health(rig.readStored(2));
      const configured = configuredOf(health, 'openai-compatible');
      return {
        value: `control-b put.status=${put.status} configured[openai-compatible]=${configured}`,
        ok: put.status === 200 && configured === true,
      };
    },
  },
  {
    name: 'AC3 control-b dashscope-omni',
    run: async (rig) => {
      const health = rig.health(rig.readStored(2));
      const configured = configuredOf(health, 'dashscope-omni');
      return { value: `control-b configured[dashscope-omni]=${configured}`, ok: configured === false };
    },
  },
  {
    // AC5: the readback face. Non-empty, not the plaintext, not containing it, and carrying the
    // fixed marker — four conditions on ONE reading, so "masked everything" and "masked nothing"
    // both fail here rather than at different readings.
    name: 'AC5 get.dashscopeApiKey',
    run: async (rig) => {
      const get = await callRouter(rig.router, { method: 'GET', url: '/config' });
      const value = stringOf(bodyOf(get), 'dashscopeApiKey');
      const ok =
        value !== '' && value !== DASHSCOPE_KEY && !value.includes(DASHSCOPE_KEY) && value.includes(CREDENTIAL_MASK);
      return { value: `get.dashscopeApiKey=${describeSecret(value)} masked=${ok}`, ok };
    },
  },
  {
    // The same face on the SAVE response: a client compares the two, and an unmasked save response
    // would be a second place the value leaves the process.
    name: 'AC5 put.dashscopeApiKey',
    run: (rig) => {
      const put = rig.savedPut;
      const value = stringOf(bodyOf(put), 'dashscopeApiKey');
      const ok =
        put !== undefined &&
        put.status === 200 &&
        value !== '' &&
        value !== DASHSCOPE_KEY &&
        !value.includes(DASHSCOPE_KEY) &&
        value.includes(CREDENTIAL_MASK);
      return { value: `put.dashscopeApiKey=${describeSecret(value)} masked=${ok}`, ok };
    },
  },
  {
    // The pair the BROWSER keeps is not the server's to hide: masking it would break the direct path
    // AC-140 preserved, and the settings tab could never hand it back.
    //
    // READ FROM THE OTHER USER'S DOCUMENT, deliberately: the first user's document has its shared
    // pair empty (that emptiness is what AC3's control turns on), and comparing an empty string to
    // an empty string would pass against a mask that blanked every field — a reading that cannot
    // tell "verbatim" from "removed" is not a reading. This user saved a non-empty pair.
    name: 'AC5 get.verbatim-pair',
    run: async (rig) => {
      const get = await callRouter(rig.router, { method: 'GET', url: '/config', user: 2 });
      const body = bodyOf(get);
      const baseUrl = stringOf(body, 'baseUrl');
      const apiKey = stringOf(body, 'apiKey');
      const ok = get.status === 200 && baseUrl === BROWSER_BASE_URL && apiKey === BROWSER_API_KEY;
      return {
        value: `get.user2.baseUrl=${baseUrl || '(empty)'} get.user2.apiKey=${describeSecret(apiKey)} verbatim=${ok}`,
        ok,
      };
    },
  },
  {
    name: 'AC5 put.verbatim-pair',
    run: (rig) => {
      const put = rig.controlPut;
      const body = bodyOf(put);
      const baseUrl = stringOf(body, 'baseUrl');
      const apiKey = stringOf(body, 'apiKey');
      const ok = put !== undefined && put.status === 200 && baseUrl === BROWSER_BASE_URL && apiKey === BROWSER_API_KEY;
      return {
        value: `put.user2.baseUrl=${baseUrl || '(empty)'} put.user2.apiKey=${describeSecret(apiKey)} verbatim=${ok}`,
        ok,
      };
    },
  },
  {
    // The mask must not turn "not filled" into "filled with something you cannot see": a user who
    // never set the key has to read back the empty string, or the field could never be cleared.
    name: 'AC5 empty-stays-empty',
    run: async (rig) => {
      const put = await rig.put({ ...SAVED_DOCUMENT, dashscopeApiKey: '' }, 3);
      rig.emptyPut = put;
      const get = await callRouter(rig.router, { method: 'GET', url: '/config', user: 3 });
      rig.emptyGet = get;
      const fromPut = stringOf(bodyOf(put), 'dashscopeApiKey');
      const fromGet = stringOf(bodyOf(get), 'dashscopeApiKey');
      const ok = put.status === 200 && get.status === 200 && fromPut === '' && fromGet === '';
      return { value: `empty.put=${fromPut === '' ? '(empty)' : fromPut} empty.get=${fromGet === '' ? '(empty)' : fromGet}`, ok };
    },
  },
  {
    // AC5 (b): the mask is a readback face and not the value. The upstream really receives the
    // plaintext on the wire, or "saved and configured" would be a statement about a mask.
    name: 'AC5 wire.authorization',
    run: async (rig) => {
      rig.upstream.calls.length = 0;
      rig.upstream.respondWith(() => ({ status: 200, body: SUCCESS_ANSWER, contentType: 'application/json' }));
      const result = await rig.transcribe(rig.readStored(1));
      rig.wired = { result };
      const authorization = rig.upstream.calls[0]?.headers.authorization;
      rig.wired.authorization = authorization;
      const expected = `Bearer ${DASHSCOPE_KEY}`;
      return {
        value: `wire.authorization=Bearer ${DASHSCOPE_KEY.slice(0, 3)}… verbatim=${authorization === expected} transport-ok=${result.ok}`,
        ok: authorization === expected,
      };
    },
  },
  {
    // AC6: TTS is driven with the deployment's pair while the provider's document sits in storage.
    // The URL is the whole check that the new fields did not become a second source for it.
    name: 'AC6 tts.url',
    run: async (rig) => {
      rig.upstream.calls.length = 0;
      const tts = rig.buildService({ defaults: DEPLOYMENT_DEFAULTS });
      const result = await tts.synthesizeSpeech({ text: 'criterion tts text', overrides: {} });
      const call = rig.upstream.calls[0];
      rig.tts = call;
      const expected = `${BROWSER_BASE_URL}/audio/speech`;
      const ok = result.ok && call !== undefined && call.url === expected;
      return { value: `tts.url=${call?.url ?? '(none)'} expected=${expected}`, ok };
    },
  },
  {
    name: 'AC6 tts.authorization',
    run: (rig) => {
      const authorization = rig.tts?.headers.authorization;
      const expected = `Bearer ${BROWSER_API_KEY}`;
      return {
        value: `tts.authorization=Bearer ${BROWSER_API_KEY.slice(0, 3)}… verbatim=${authorization === expected}`,
        ok: authorization === expected,
      };
    },
  },
  {
    name: 'AC6 tts.body-model-voice',
    run: (rig) => {
      const body = jsonParseOrNull(rig.tts?.bodyText ?? '');
      const model = typeof body?.model === 'string' ? body.model : '';
      const voice = typeof body?.voice === 'string' ? body.voice : '';
      const ok = model === DEPLOYMENT_DEFAULTS.ttsModel && voice === DEPLOYMENT_DEFAULTS.ttsVoice;
      return { value: `tts.body.model=${model} tts.body.voice=${voice} unchanged=${ok}`, ok };
    },
  },
  {
    // The separation, in one reading: neither the provider's address nor its key appears anywhere in
    // what TTS sent — URL, headers and body together.
    name: 'AC6 tts.carries-dashscope',
    run: (rig) => {
      const serialised = JSON.stringify(rig.tts ?? {});
      const carries = serialised.includes(DASHSCOPE_ENDPOINT) || serialised.includes(DASHSCOPE_KEY);
      return { value: `tts.carries-dashscope=${carries}`, ok: carries === false };
    },
  },
  {
    // AC7's discrimination, part one: a success and a failure, so "no leak" is not "no logging".
    name: 'AC7 log.lines',
    run: async (rig) => {
      rig.logLines.length = 0;
      rig.upstream.calls.length = 0;
      rig.upstream.respondWith(() => ({ status: 200, body: SUCCESS_ANSWER, contentType: 'application/json' }));
      const ok = await rig.transcribe(rig.readStored(1));
      const authorization = rig.upstream.calls[0]?.headers.authorization;
      rig.upstream.respondWith(() => ({ status: 403, body: 'criterion forbidden' }));
      const fail = await rig.transcribe(rig.readStored(1));
      rig.logged = { ok, fail, authorization };
      return { value: `log.lines=${rig.logLines.length}`, ok: rig.logLines.length >= 2 };
    },
  },
  {
    // Distinguishable by outcome and status: two lines saying the same thing would satisfy a count
    // and tell a reader nothing about which attempt is which.
    name: 'AC7 log.carries-outcome',
    run: (rig) => {
      const lines = rig.logLines;
      const okLine = lines.find((line) => line.includes('outcome=ok') && line.includes('status=200'));
      const failLine = lines.find((line) => line.includes('outcome=fail') && !line.includes('status=200'));
      const ok = okLine !== undefined && failLine !== undefined;
      return { value: `log.carries-outcome=${ok} ok-line=${okLine ?? '(none)'} fail-line=${failLine ?? '(none)'}`, ok };
    },
  },
  {
    // The needles: the credential, its bearer form, the recording's own bytes, and both texts the
    // model answered with. Each is a string that exists in this process and nowhere in the log.
    name: 'AC7 log.needleHits',
    run: (rig) => {
      const needles = [DASHSCOPE_KEY, `Bearer ${DASHSCOPE_KEY}`, AUDIO_BASE64, SUCCESS_TRANSCRIPT, SUCCESS_INSTRUCTION];
      const hits = rig.logLines.filter((line) => needles.some((needle) => line.includes(needle)));
      return { value: `log.needleHits=${hits.length} log.lines=${rig.logLines.length}`, ok: hits.length === 0 };
    },
  },
  {
    // AC7 (c): the body WAS returned to the caller, so "it is not in the log" is a discrimination
    // rather than a statement that the text never existed in this process.
    name: 'AC7 log.body-returned',
    run: (rig) => {
      const result = rig.logged?.ok;
      const returned = result !== undefined && result.ok && result.value.text === SUCCESS_INSTRUCTION;
      return { value: `log.body-returned=${returned} body-length=${SUCCESS_INSTRUCTION.length}`, ok: returned };
    },
  },
  {
    // AC7 (b): the plaintext really went out, on this attempt, through this stub.
    name: 'AC7 wire.plaintext-key-sent',
    run: (rig) => {
      const sent = rig.logged?.authorization === `Bearer ${DASHSCOPE_KEY}`;
      const failStatus = rig.logged?.fail !== undefined && !rig.logged.fail.ok ? rig.logged.fail.status : null;
      return { value: `wire.plaintext-key-sent=${sent} fail.status=${failStatus}`, ok: sent === true };
    },
  },
  {
    // AC7's port claim, as a discrimination rather than as prose: with a port injected, the port gets
    // the line and `console` gets nothing; with no port, `console` gets it. The spy is this file's
    // own, installed for the duration of the probe and restored immediately — the shipping module
    // holds no `console` assignment at all (see the identity reading below).
    name: 'AC7 log.port-or-console',
    run: async (rig) => {
      const consoleLines: string[] = [];
      const patched = console as unknown as { info: (...args: unknown[]) => void };
      const original = patched.info;
      rig.upstream.respondWith(() => ({ status: 200, body: SUCCESS_ANSWER, contentType: 'application/json' }));

      let portDelta = 0;
      let consoleDelta = 0;
      try {
        rig.logLines.length = 0;
        patched.info = (...args: unknown[]) => {
          consoleLines.push(args.map((arg) => String(arg)).join(' '));
        };

        await rig.transcribe(rig.readStored(1));
        portDelta = rig.logLines.length;
        const installedConsoleDelta = consoleLines.length;

        const noPort = rig.buildService();
        await noPort.transcribe({
          audio: { bytes: AUDIO_BYTES, mimeType: 'audio/webm', fileName: 'recording.webm' },
          overrides: {},
          settings: rig.readStored(1),
        });
        consoleDelta = consoleLines.length - installedConsoleDelta;
      } finally {
        patched.info = original;
      }

      const restored = console.info === ORIGINAL_CONSOLE_INFO;
      const ok = portDelta === 1 && consoleDelta === 1 && restored;
      return {
        value: `log.port-or-console port-lines=${portDelta} console-lines=${consoleDelta} default-is-console=${consoleDelta === 1} restored=${restored}`,
        ok,
      };
    },
  },
  {
    name: 'AC7 log.console-untouched',
    run: () => ({
      value: `log.console-untouched=${console.info === ORIGINAL_CONSOLE_INFO}`,
      ok: console.info === ORIGINAL_CONSOLE_INFO,
    }),
  },
  {
    // AC8: no provider id is branched on in the shipping server tree.
    //
    // THE WHOLE TREE IS SCANNED, `tests/` INCLUDED, and the hits are PARTITIONED rather than
    // filtered away — because the literal does occur under `server/`, in test fixtures that name a
    // provider (this file among them, in the reading names and in the document it saves). A reading
    // that simply skipped those directories would print `hits=0` and leave a reader who ran
    // `grep -rn "'dashscope-omni'" server/` looking at a contradiction. What the criterion asserts
    // is the part that matters and the part the AC names — the server does not BRANCH on the id, so
    // no non-test file contains it — and it reports the test-directory occurrences beside that, by
    // path, so the two statements are checkable against each other.
    name: 'AC8 server-branch-scan',
    run: async () => {
      const needles = [`'dashscope-omni'`, `"dashscope-omni"`];
      const files = await collectSourceFiles(SERVER_DIR);
      const shippingHits: string[] = [];
      const fixtureHits: string[] = [];
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        if (!needles.some((needle) => text.includes(needle))) {
          continue;
        }
        const where = path.relative(SERVER_DIR, file);
        (isTestPath(file) ? fixtureHits : shippingHits).push(where);
      }
      return {
        value:
          `server-branch-scan files=${files.length} shipping-hits=${shippingHits.length}` +
          (shippingHits.length === 0 ? '' : ` [${shippingHits.join(' ')}]`) +
          ` test-fixture-hits=${fixtureHits.length} [${fixtureHits.join(' ')}]` +
          ` (equivalent: grep -rn "'dashscope-omni'" server/)`,
        ok: shippingHits.length === 0,
      };
    },
  },
  {
    // The one copy, proven by identity: the object the registry hands out IS the module's export, so
    // the field names travel from the provider's own declaration and not from a table in the server.
    name: 'AC8 declaration-source',
    run: async () => {
      const registry = (await import(pathToFileURL(REGISTRY_MODULE).href)) as unknown as {
        listProviders: () => readonly AsrAdapter[];
      };
      // The registry first, the provider module second: importing the adapter before the registry it
      // imports from is the one order that reads a binding before its module initialized.
      const providers = registry.listProviders();
      const providerModule = (await import(pathToFileURL(DASHSCOPE_MODULE).href)) as unknown as {
        credentials: AsrAdapter['credentials'];
      };
      const registered = providers.map((adapter) => adapter.credentials).find((fields) => fields !== undefined);
      const declared = providerModule.credentials;
      const same = registered !== undefined && declared !== undefined && registered === declared;
      const names =
        declared === undefined
          ? '(none)'
          : `endpointField=${declared.endpointField} apiKeyField=${declared.apiKeyField} modelField=${declared.modelField ?? '(absent)'}`;
      return {
        value:
          `declaration=shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#credentials ` +
          `${names} registry-shares-the-object=${same}`,
        ok: same,
      };
    },
  },
  {
    // The positive control for the scan above: the same needle, on the file that declares the id.
    // "Looked and found nothing" and "never looked" are different readings, and this is the one that
    // tells them apart.
    name: 'AC8 control-provider-module-hits',
    run: async () => {
      const text = await readFile(DASHSCOPE_MODULE, 'utf8');
      const hits = (text.match(/'dashscope-omni'/g) ?? []).length;
      return { value: `control-provider-module-hits=${hits}`, ok: hits >= 1 };
    },
  },
];

/** The all-empty document, for the reading that asks what an unconfigured link looks like. */
const SAVED_DOCUMENT_EMPTY: VoiceSettings = {
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

/**
 * Runs every reading against one session, in order.
 *
 * TOTAL BY CONSTRUCTION: a reading that throws is reported as a failed reading carrying the failure's
 * message, because the falsify run has to see WHICH reading noticed a mutation, and an exception
 * escaping the list would end the run at the first one instead.
 */
export async function collectReadings(
  modulePath: string = SHIPPING_SERVICE_MODULE,
  onMeasured?: (outcome: ReadingOutcome) => void,
): Promise<ReadingOutcome[]> {
  const rig = await openRig(modulePath);
  try {
    const outcomes: ReadingOutcome[] = [];
    for (const reading of READINGS) {
      let outcome: ReadingOutcome;
      try {
        const measured = await reading.run(rig);
        outcome = { name: reading.name, value: measured.value, ok: measured.ok };
      } catch (error) {
        outcome = {
          name: reading.name,
          value: `threw: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        };
      }
      outcomes.push(outcome);
      onMeasured?.(outcome);
    }
    return outcomes;
  } finally {
    await rig.close();
  }
}

// ── AC4(b): the scan's exclusion of a sibling's temp copies, from both sides ───────────────────

/** The reading this case holds to account, by the name the list registers it under. */
const AC8_SCAN_READING = 'AC8 server-branch-scan';

/** The `files=` figure out of the scan's measured value, or `null` when the value is not its shape. */
function scanFileCount(value: string): number | null {
  const match = /files=(\d+)/.exec(value);
  return match === null ? null : Number(match[1]);
}

/** The one reading this case is about, out of a full run of the list. */
function scanOutcome(outcomes: readonly ReadingOutcome[]): ReadingOutcome {
  const found = outcomes.find((outcome) => outcome.name === AC8_SCAN_READING);
  assert.ok(found !== undefined, `${AC8_SCAN_READING} did not run at all`);
  return found;
}

/**
 * How long after a run starts its probe copy is deleted, one value per repetition.
 *
 * A SINGLE DELAY WOULD ONLY SAMPLE ONE INSTANT of a ~1 s run, and the window this exclusion has to
 * close is narrow: `collectSourceFiles` traverses the directory, then the loop reads each file it
 * collected, so a copy deleted between those two syscalls is collected and then missing. The sweep
 * is spread from "delete while the reading list is still opening its rig" to "delete well after the
 * scan finished", so across the repetitions the deletion lands in every phase including the one that
 * used to throw. Deterministic as a set, which is what "20 times, all green" is asking for.
 */
const AC4B_DELAYS_MS = [
  0, 1, 2, 4, 8, 15, 25, 40, 60, 90, 130, 180, 240, 320, 420, 540, 680, 850, 1050, 1300,
] as const;

/**
 * The positive control's file, under the git-ignored `tmp/` directory of the module directory.
 *
 * WHY IT IS NOT BESIDE THE MODULE. The scan skips a `__criterion-falsify-` name, so the control has
 * to be a file the scan will COLLECT — but a stray untracked file beside the module would also be a
 * stray line in the `git status --porcelain` of every sibling criterion sampling at that instant,
 * which is the very cross-file artifact (a neighbour's file reported as this run's change) that this
 * task exists to remove. `tmp/` is in `.gitignore`, so the plant is invisible to `git status` while
 * remaining exactly what the exclusion must not swallow: a prefix-less `.ts` file under `server/`,
 * outside any `tests/` directory, containing the provider id.
 */
const AC4B_POSITIVE_DIR = path.join(VOICE_MODULE_DIR, 'tmp');
const AC4B_POSITIVE_FILE = path.join(AC4B_POSITIVE_DIR, `${STRAY_PROBE_PREFIX}${process.pid}.ts`);

// ── the criterion, as `node:test` cases (registered only when this file is the entry point) ────

const IS_ENTRY = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  if (READINGS.length !== READINGS_EXPECTED) {
    test('AC1 the declared reading count matches the list', () => {
      assert.equal(
        READINGS.length,
        READINGS_EXPECTED,
        'READINGS_EXPECTED and the reading list disagree; update the constant with the list',
      );
    });
  }

  let measurementCount = 0;
  let shippingRig: Promise<Rig> | undefined;
  const rigOnce = (): Promise<Rig> => (shippingRig ??= openRig(SHIPPING_SERVICE_MODULE));

  for (const [index, reading] of READINGS.entries()) {
    test(reading.name, async () => {
      const rig = await rigOnce();
      measurementCount += 1;
      const measured = await reading.run(rig);
      // Printed BEFORE the assertion, so a red names itself and its measured value in the log
      // rather than only in the assertion's diff.
      process.stdout.write(`reading ${reading.name} = ${measured.value}\n`);
      assert.equal(
        measured.ok,
        true,
        `reading ${index + 1}/${READINGS_EXPECTED} '${reading.name}' measured ${measured.value}`,
      );
    });
  }

  /**
   * AC4(b): the scan neither counts a neighbour's in-flight copy nor loses a real hit because of it.
   *
   * THE FAULT THIS HOLDS SHUT, in the shape it was measured: `collectSourceFiles` traverses the
   * directory and then the loop `readFile`s what it collected. A sibling criterion writing and
   * deleting `__criterion-falsify-*.ts` in that same directory, at four-file concurrency, can be
   * deleted between those two syscalls — and the `ENOENT` that follows reaches `collectReadings` as
   * `ok=false` with the exception's message, which in shape is exactly what a real hit looks like.
   * This case makes that window fire on purpose, twenty times at twenty different offsets, and the
   * scan has to be unmoved by all of them.
   *
   * TWO ASSERTIONS, NOT ONE, because there are two ways to make the scan stable and only one of them
   * is correct: dropping every non-test file would also be "stable". So the churn is followed by a
   * POSITIVE CONTROL — a prefix-less file that really does contain the provider id — which must turn
   * the very same reading red with `shipping-hits=1` and name it. Stability plus a live positive
   * control is the whole claim.
   */
  test('AC4(b) the AC8 scan is stable under a neighbour’s temp copies and still finds a real hit', async () => {
    const results: { delay: number; ok: boolean; value: string; files: number | null }[] = [];

    for (const [index, delay] of AC4B_DELAYS_MS.entries()) {
      const probe = path.join(VOICE_MODULE_DIR, `${TEMP_COPY_PREFIX}ac8probe-${process.pid}-${index}.ts`);
      await writeFile(probe, '// a sibling-shaped in-flight temp copy\n', 'utf8');
      const [outcomes] = await Promise.all([
        collectReadings(SHIPPING_SERVICE_MODULE),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          await rm(probe, { force: true });
          assert.equal(
            await readFile(probe, 'utf8').then(() => true, () => false),
            false,
            `the churn probe ${probe} was not removed, so the repetition below is not the one it claims`,
          );
        })(),
      ]);
      const scan = scanOutcome(outcomes);
      results.push({ delay, ok: scan.ok, value: scan.value, files: scanFileCount(scan.value) });
      process.stdout.write(`ac8-churn n=${index} delay-ms=${delay} ok=${String(scan.ok)} ${scan.value}\n`);
    }

    const reds = results.filter((entry) => !entry.ok);
    assert.deepEqual(
      reds.map((entry) => `delay-ms=${entry.delay} measured ${entry.value}`),
      [],
      'a temp copy belonging to another process made the scan red; that is the shared-directory ' +
        'artifact this exclusion exists to remove, not a hit in the product tree',
    );

    const counts = [...new Set(results.map((entry) => entry.files))];
    process.stdout.write(
      `ac8-churn-summary repetitions=${results.length} distinct-files-counts=${counts.length} ` +
        `files=${counts.join(',')} all-ok=${String(reds.length === 0)}\n`,
    );
    assert.equal(counts.length, 1, `the scan's file count followed a neighbour's churn: ${counts.join(',')}`);
    assert.ok(
      counts[0] !== null && counts[0] > 0,
      `the scan counted ${String(counts[0])} files, which is not a scan of the product tree`,
    );

    // ── the positive control: the exclusion is by NAME, not "skip anything untracked" ──────────
    await mkdir(AC4B_POSITIVE_DIR, { recursive: true });
    try {
      await writeFile(AC4B_POSITIVE_FILE, "export const providerId = 'dashscope-omni';\n", 'utf8');
      const control = scanOutcome(await collectReadings(SHIPPING_SERVICE_MODULE));
      process.stdout.write(`ac8-positive-control ok=${String(control.ok)} ${control.value}\n`);
      assert.equal(
        control.ok,
        false,
        'a prefix-less product file containing the provider id did not red the scan: the exclusion ' +
          `has swallowed a real hit, so the stability above is vacuous (measured ${control.value})`,
      );
      assert.match(control.value, /shipping-hits=1/, 'the real hit was not counted as a shipping hit');
      assert.ok(
        control.value.includes(path.basename(AC4B_POSITIVE_FILE)),
        `the red did not name the file that caused it: ${control.value}`,
      );
    } finally {
      // Only THIS process's control: `tmp/` is shared with every other process running this file.
      await rm(AC4B_POSITIVE_FILE, { force: true });
      await rmdir(AC4B_POSITIVE_DIR).catch(() => undefined); // non-empty = a neighbour's probe is in it
    }
  });

  after(async () => {
    if (shippingRig !== undefined) {
      await (await shippingRig).close();
    }
  });

  test('AC1 the reading counter matches READINGS_EXPECTED', () => {
    process.stdout.write(`elapsed-ms=${Date.now() - STARTED_AT}\n`);
    process.stdout.write(SCOPE_REGISTRATION);
    assert.equal(
      measurementCount,
      READINGS_EXPECTED,
      `${measurementCount} readings ran but READINGS_EXPECTED is ${READINGS_EXPECTED}: a reading was ` +
        'skipped, which reads exactly like a shorter green list',
    );
    assert.ok(
      READINGS.length >= READINGS_EXPECTED,
      `the run must register at least ${READINGS_EXPECTED} cases for the summary's pass count to mean anything`,
    );
  });
}

/**
 * AC12: what this criterion did and did not measure, printed with every run.
 *
 * Printed rather than only written in the task, because the shape of the evidence is the claim: an
 * injected transport and an injected log port over a real SQLite file prove the server's credential
 * face and nothing about a live account or a browser.
 */
const SCOPE_REGISTRATION = [
  'scope: this task stores and masks the USER-provided DashScope credential, reports `configured` per provider, ',
  'and logs each attempt without the key or the body. NOT in scope, and not measured here: the dashscope-omni ',
  'adapter and its wire (AC-138), server-side dispatch and the code→status table (AC-139), the host allow-list ',
  'rule itself (AC-140 — this task only calls the rule it declares, on the save path), the settings UI and the ',
  'browser end-to-end path (AC-142). Every reading runs under an injected transport, an injected log port and a ',
  'temp SQLite database; the live DashScope smoke is a human step (ADR-004 decision 8). `qwen3.8-omni-flash` is ',
  'an alias, so a re-pointed service may drift from the frozen readings, and the workspace address used here is ',
  'the shape an experiment record contains rather than one taken from a live key. Known non-equivalence, ',
  'registered rather than fixed: `src/shared/voiceConfig.ts` PUTs all six shared fields, and the server reads a ',
  'missing field as "clear", so until AC-142 wires the new fields into the settings page a save from an ',
  'old-six-fields client clears the three stored provider values. That path is AC-142\'s, not this task\'s.\n',
].join('');
