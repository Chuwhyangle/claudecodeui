#!/usr/bin/env node
/**
 * The probe for the container whitelist and the two-layer size limit (AC-133).
 *
 * WHAT IT IS ASKING. Two gaps, and both are about a rule that was written down twice rather than
 * once — so the readings are about WHERE a rule comes from, not about a value being what it is.
 *
 *   1. Does the container whitelist belong to the SELECTED provider's declaration? The case that
 *      matters is the recording this app makes itself: the browser's preferred type is
 *      `audio/webm;codecs=opus`, while every published figure is a base type. A whitelist matched
 *      by exact string refuses the app's own output, and a whitelist that is a constant of the
 *      route's own goes stale the day a provider changes.
 *   2. Is the size limit two layers, and does the size refusal say 413? Multer runs before the
 *      handler and cannot know the provider, so its figure can only be a ceiling above every
 *      declared budget; the selected provider's own budget is only knowable after the bytes are
 *      buffered. A single number would either truncate a request a provider could have served, or
 *      hand a provider bytes past what it declared.
 *
 * HOW IT READS THEM. The static readings are text reads of the tree it is pointed at, so they work
 * on a fixture the falsification controls have mutated. The behavioural readings drive the tree's
 * OWN modules: a reader is written to a temporary directory, `tsx` loads the tree's `voice.service.ts`,
 * `voice.routes.ts` and `src/shared/api/index.ts` from it by absolute path, and the service, the router and
 * the client are constructed and called there. Driving the real modules is the point — a probe that
 * re-derived the answers from the source text could only ever confirm its own re-derivation.
 *
 * The two faces are driven under their own compiler configurations, because that is the whole
 * reason the seam landed in the repository-root `shared/` tree: `@/shared/*` means `server/shared/*`
 * to the server and `src/shared/*` to the browser, so one reader cannot load both.
 *
 * The readers live outside the tree they read, so a run leaves the tree byte-identical.
 *
 * READINGS (one `key=value` line each, then a verdict):
 *   landing, landing-candidate, server-compiles-landing  — the ADR-004 decision 3 landing (AC8)
 *   whitelist-source                                     — the symbol the whitelist comes from (AC6)
 *   client-whitelist-source, transport-ceiling-source     — the same question on the other two sites
 *   mime-constant-tables                                 — a second table of media types (AC6)
 *   declared-container-bare/-parameterised/-case          — AC2, including the recorder's own type
 *   outside-container, outside-container-upstream-calls   — AC1, AC7
 *   oversize, oversize-upstream-calls, inside-budget      — AC3, AC7
 *   provider-switch-container, provider-switch-budget     — AC5, read off the adapter's gate
 *   transport-ceiling, transport-non-ceiling              — AC3, the transport layer's own status
 *   direct-outside-container, direct-outside-container-upstream-calls, direct-declared-container
 *   two-paths-same-code                                  — AC4, one code on both faces
 *
 * --landing prints only the landing readings. AC8 is the assertion that the landing is candidate
 * (a): both gaps are server-side rule changes, and a registry the server cannot compile would make
 * the whole task unlandable rather than merely wrong.
 *
 * Run with: node scripts/asr-mime-size-gaps-check.mjs [--root <tree>] [--landing]
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/** The registry's home when the landing is candidate (a): the tree BOTH compiler configurations read. */
const LANDING = 'shared/asr';
const LANDING_MODULE = `${LANDING}/asrRegistry.ts`;
/** Where the same module would land if the frontend tree claimed it. The server cannot compile this one. */
const FRONTEND_LANDING_MODULE = 'src/shared/asr/asrRegistry.ts';

/** The four sites this probe reads, and the two compiler configurations that can load them. */
const REGISTRY_MODULE = LANDING_MODULE;
/**
 * The contract leaf the registry re-exports. The `acceptsMime` gate is a definition, not a
 * re-export, so the source reading has to look where the function lives rather than where the
 * runtime entry point is.
 */
const CONTRACT_MODULE = `${LANDING}/contract/asrContract.ts`;
const SERVICE_MODULE = 'server/modules/voice/voice.service.ts';
const ROUTES_MODULE = 'server/modules/voice/voice.routes.ts';
const MODULE_MODULE = 'server/modules/voice/voice.module.ts';
const CLIENT_API_MODULE = 'src/shared/api/index.ts';

const ROOT_TSCONFIG = 'tsconfig.json';
const SERVER_TSCONFIG = 'server/tsconfig.json';

/**
 * The entries a fixture is built from — the smallest tree every reading can be produced from.
 *
 * Directories are copied whole rather than enumerated file by file: the two readers' transitive
 * imports run through the server's own shared helpers, and a hand-written list of those drifts the
 * moment one of them grows an import. Naming the ROOTS of each import graph keeps the fixture
 * honest as the graph moves.
 */
export const FIXTURE_ENTRIES = [
  ROOT_TSCONFIG,
  SERVER_TSCONFIG,
  'shared',
  'server/shared',
  'server/modules/voice',
  'src/shared',
];

/**
 * Builds the tree the probe is pointed at, OUT OF THE SHIPPING FILES — copied, never re-typed.
 *
 * A fixture checked into the repository would be a second copy of the implementation that nothing
 * keeps in step, and a hand-written stub would prove the probe reads the stub rather than this
 * repository's real modules.
 *
 * The one thing a copy cannot carry is the installed dependencies: the route module imports
 * `express`, and ESM resolves a bare specifier by walking up from the importing FILE, which in a
 * temporary directory finds nothing. Linking the checkout's own `node_modules` is what makes the
 * fixture a tree rather than an installation.
 *
 * @param {string} root absolute path of the tree to build
 */
export function buildFixture(root) {
  for (const entry of FIXTURE_ENTRIES) {
    const destination = path.join(root, entry);
    cpSync(path.join(REPO_ROOT, entry), destination, { recursive: true });
  }
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
function readTreeFile(root, relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {string} the file's text, or the empty string when the tree does not have it
 */
function readTreeFileOrEmpty(root, relativePath) {
  return existsSync(path.join(root, relativePath)) ? readTreeFile(root, relativePath) : '';
}

/**
 * The browser surface `src/shared/api/index.ts` reads.
 *
 * The direct path is a browser path, and its settings and token live in browser storage. The
 * stubs are the smallest surface those reads need: an empty store (so the reading is "this user
 * configured nothing", which is the state the proxy hop is chosen in) and a `window` that accepts
 * the config-change event the hydration dispatches. Written before the module is imported, because
 * the platform constants are read at module load.
 */
const BROWSER_STUBS = `const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
globalThis.window = {
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};
`;

/**
 * The server-side reader: the proxy face, and the transport layer of the same limit.
 *
 * Every attempt counts what the service handed the transport, so "refused before the upstream was
 * read" is a counter rather than an inference from the absence of a side effect.
 * @param {string} root absolute path of the tree under test
 * @returns {string}
 */
function serverReaderSource(root) {
  return `const root = ${JSON.stringify(root)};
const service = await import(root + '/${SERVICE_MODULE}');
const routes = await import(root + '/${ROUTES_MODULE}');
const registry = await import(root + '/${REGISTRY_MODULE}');

const DEFAULTS = { baseUrl: 'https://voice.example/v1', apiKey: 'sk-server', sttModel: 'whisper-1', ttsModel: 'tts-1', ttsVoice: 'alloy', providerId: '' };
const declaration = registry.listProviders()[0].capabilities;

function made() {
  const sent = [];
  const instance = service.createVoiceService({
    defaults: DEFAULTS,
    timeoutMs: 1000,
    fetchBackend: async (url) => { sent.push(url); return new Response(JSON.stringify({ text: 'ok' }), { status: 200 }); },
  });
  return { instance, sent };
}

async function attempt(mimeType, byteLength) {
  const { instance, sent } = made();
  const result = await instance.transcribe({
    audio: { bytes: new Uint8Array(byteLength), mimeType, fileName: 'a' },
    overrides: {},
  });
  return { result, upstreamCalls: sent.length };
}

const reading = { declarationBudget: declaration.maxInlineRequestBytes };

reading.bare = await attempt('audio/webm', 1024);
reading.parameterised = await attempt('audio/webm;codecs=opus', 1024);
reading.upperCase = await attempt('AUDIO/WEBM', 1024);
reading.outside = await attempt('audio/x-m4a', 1024);
reading.oversize = await attempt('audio/webm', declaration.maxInlineRequestBytes + 1);
reading.atBudget = await attempt('audio/webm', declaration.maxInlineRequestBytes);

// The provider switch, read off the ADAPTER's gate with a second declaration rather than off a
// second request: one registry entry cannot show that the rule follows the declaration it is
// handed, and both gates are exported for exactly this reading.
const narrow = { ...declaration, acceptsMime: ['audio/ogg', 'audio/opus'], maxInlineRequestBytes: 4096 };
reading.switch = {
  containerRefused: service.containerRefusal(narrow, 'other', 'audio/webm') !== null,
  containerAccepted: service.containerRefusal(narrow, 'other', 'audio/ogg') === null,
  budgetRefused: service.budgetRefusal(narrow, 'other', 5000)?.code === 'OVERSIZE',
  budgetAccepted: service.budgetRefusal(narrow, 'other', 4000) === null,
};

// The transport layer: the parser fails before the handler and no provider is known yet, so this
// is where the ceiling's own status is read.
function dispatch(uploadError) {
  const router = routes.createVoiceRouter({
    voiceService: {
      getHealth: () => ({ ok: false, status: 500, error: 'unused' }),
      transcribe: async () => ({ ok: true, value: { text: '' } }),
      synthesizeSpeech: async () => ({ ok: false, status: 500, error: 'unused' }),
    },
    voiceSettingsService: {
      getSettings: () => ({ baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' }),
      saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
    },
    parseAudioUpload: (request, response, callback) => callback(uploadError),
  });

  let status = 0;
  let body = {};
  const response = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  router({ method: 'POST', url: '/transcribe', headers: {} }, response, (error) => { throw error; });
  return { status, body };
}

reading.transportCeiling = dispatch(Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' }));
reading.transportOther = dispatch(new Error('Unexpected field'));

process.stdout.write('ASR_MIME_SIZE_READING ' + JSON.stringify(reading) + '\\n');
`;
}

/**
 * The browser-side reader: the direct face.
 * @param {string} root absolute path of the tree under test
 * @returns {string}
 */
function clientReaderSource(root) {
  return `${BROWSER_STUBS}const root = ${JSON.stringify(root)};
const api = await import(root + '/${CLIENT_API_MODULE}');
const voiceConfig = await import(root + '/src/shared/api/voiceConfig.ts');
const registry = await import(root + '/${REGISTRY_MODULE}');

const provider = registry.listProviders()[0];
api.setVoiceProviderProfile({ id: provider.id, capabilities: provider.capabilities });

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
};

// The settings hop is not a transcription request. Hydrated once, up front, so every count below
// is the number of times this attempt reached a recogniser and nothing else.
await voiceConfig.whenVoiceConfigReady();
calls.length = 0;

async function attempt(mimeType) {
  const before = calls.length;
  const response = await api.transcribeVoice(
    new Blob([new Uint8Array(1024)], { type: mimeType }),
    'recording.webm',
  );
  let code = null;
  try {
    const body = await response.clone().json();
    code = typeof body?.code === 'string' ? body.code : null;
  } catch {
    code = null;
  }
  return { status: response.status, code, upstreamCalls: calls.length - before };
}

const reading = {
  declared: await attempt('audio/webm'),
  parameterised: await attempt('audio/webm;codecs=opus'),
  outside: await attempt('audio/x-m4a'),
};

process.stdout.write('ASR_MIME_SIZE_READING ' + JSON.stringify(reading) + '\\n');
`;
}

/**
 * Runs a reader against `root` and returns the reading it printed.
 * @param {string} root
 * @param {string} tsconfig
 * @param {string} source
 * @returns {{ value: unknown, error: string | null }}
 */
function readBehaviour(root, tsconfig, source) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'asr-mime-size-probe-'));
  try {
    const readerPath = path.join(directory, 'reader.mjs');
    writeFileSync(readerPath, source);
    const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const result = spawnSync(
      tsx,
      ['--tsconfig', path.join(root, tsconfig), readerPath],
      { encoding: 'utf8', cwd: root },
    );
    const line = (result.stdout || '').split('\n').find((entry) => entry.startsWith('ASR_MIME_SIZE_READING '));
    if (!line) {
      const detail = (result.stderr || '').trim().split('\n').slice(-3).join(' | ');
      return { value: null, error: `the reader produced no reading (exit ${result.status}): ${detail}` };
    }
    return { value: JSON.parse(line.slice('ASR_MIME_SIZE_READING '.length)), error: null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The landing readings: where the registry lives and whether the server compiles it (AC8).
 * @param {string} root
 * @returns {{ readings: Record<string, string>, failures: string[] }}
 */
function landingReadings(root) {
  const atCandidateA = existsSync(path.join(root, LANDING_MODULE));
  const atCandidateB = existsSync(path.join(root, FRONTEND_LANDING_MODULE));
  const serverConfig = readTreeFile(root, SERVER_TSCONFIG);
  // The server build compiles the repository-root shared tree through its `include`, so a
  // landing the server cannot see is the difference between this task being landable and not.
  const serverCompilesLanding = /"\.\.\/shared\/\*\*\/\*\.ts"/.test(serverConfig);

  return {
    readings: {
      landing: atCandidateA ? LANDING : atCandidateB ? 'src/shared/asr' : 'absent',
      'landing-candidate': atCandidateA ? 'a' : atCandidateB ? 'b' : 'neither',
      'server-compiles-landing': serverCompilesLanding ? 'yes' : 'no',
    },
    failures: [
      ...(atCandidateA ? [] : [`landing: the registry is not at ${LANDING_MODULE}`]),
      ...(atCandidateB ? ['landing: the registry landed in the frontend tree (candidate b), which the server cannot compile'] : []),
      ...(serverCompilesLanding ? [] : [`landing: ${SERVER_TSCONFIG} does not compile ../shared`]),
    ],
  };
}

/**
 * Where the whitelist comes from, as a SYMBOL NAME rather than a file and line (AC6).
 *
 * Read as two halves of one call: the expression the contract's rule compares its declaration
 * against, and the expression the service passes as that declaration. A service that passed a
 * literal array would make the first half of this reading a spelling of nothing.
 */
const REGISTRY_ACCEPTS = /([A-Za-z_$][\w$]*)\.acceptsMime\.indexOf/;
const GATE_DECLARATION_ARGUMENT = /declaredAcceptsMime\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*,/;

/**
 * A second table of media types, written down where a rule should have read a declaration.
 *
 * Matched as an array literal whose first element is a media type. The capture candidates in the
 * recorder are not this: they are a question put to the browser ("what can you record?"), not an
 * answer about what a provider accepts, and they live where no gate reads them.
 */
const MEDIA_TYPE_ARRAY = /\[\s*['"](?:audio|video)\/[^'"]*['"]/;

/**
 * @param {string} root
 * @returns {{ readings: Record<string, string>, failures: string[] }}
 */
function sourceReadings(root) {
  /** @type {string[]} */
  const failures = [];

  const registry = readTreeFileOrEmpty(root, CONTRACT_MODULE);
  const service = readTreeFileOrEmpty(root, SERVICE_MODULE);
  const client = readTreeFileOrEmpty(root, CLIENT_API_MODULE);
  const module_ = readTreeFileOrEmpty(root, MODULE_MODULE);

  const registrySymbol = REGISTRY_ACCEPTS.exec(registry);
  const serviceArgument = GATE_DECLARATION_ARGUMENT.exec(service);
  const clientArgument = GATE_DECLARATION_ARGUMENT.exec(client);
  /** @param {RegExpExecArray | null} argument the gate's declaration argument, if the gate is there */
  const acceptSet = (argument) => (
    registrySymbol && argument ? `${argument[1]}.acceptsMime` : ''
  );
  const whitelistSource = acceptSet(serviceArgument);
  const clientSource = acceptSet(clientArgument);

  const ceilingSymbol = /Math\.max\(\s*ceiling\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/.exec(module_);

  const withTables = [SERVICE_MODULE, CLIENT_API_MODULE].filter((relativePath) => (
    MEDIA_TYPE_ARRAY.test(readTreeFileOrEmpty(root, relativePath))
  ));

  // AC10: an empty reading is not a green one. A whitelist whose source could not be named is a
  // reading that was never taken, which is what a deleted or renamed gate looks like from here.
  if (!whitelistSource) {
    failures.push(`AC6: the server gate's whitelist source could not be named in ${SERVICE_MODULE}`);
  }
  if (!clientSource) {
    failures.push(`AC6: the client gate's whitelist source could not be named in ${CLIENT_API_MODULE}`);
  }
  if (!ceilingSymbol) {
    failures.push(`AC6: the transport ceiling's source could not be named in ${MODULE_MODULE}`);
  }
  if (withTables.length) {
    failures.push(`AC6: a second table of media types is written down in ${withTables.join(', ')}`);
  }

  return {
    readings: {
      'whitelist-source': whitelistSource || 'unnamed',
      'client-whitelist-source': clientSource || 'unnamed',
      'transport-ceiling-source': ceilingSymbol ? ceilingSymbol[1] : 'unnamed',
      'mime-constant-tables': withTables.length ? `written-in-${withTables.length}-file(s)` : 'none',
    },
    failures,
  };
}

/**
 * @param {unknown} result a `VoiceServiceResult`
 * @returns {string} `served`, or the refusal as `status-code`
 */
function refusalOf(result) {
  const value = /** @type {any} */ (result);
  if (value?.ok === true) return 'served';
  return `refused-${value?.status}-${value?.code ?? 'none'}`;
}

/**
 * @param {unknown} reading the server reader's payload
 * @returns {{ readings: Record<string, string>, failures: string[], codes: Record<string, string> }}
 */
function serverReadings(reading) {
  /** @type {string[]} */
  const failures = [];
  const value = /** @type {any} */ (reading);

  const bare = refusalOf(value.bare?.result);
  const parameterised = refusalOf(value.parameterised?.result);
  const upperCase = refusalOf(value.upperCase?.result);
  const outside = refusalOf(value.outside?.result);
  const oversize = refusalOf(value.oversize?.result);
  const atBudget = refusalOf(value.atBudget?.result);

  // AC1 and AC2: the whitelist has to work in both directions. "Refuses everything" and "accepts
  // everything" are both wrong, and a probe that only read one of the two directions would call
  // either of them green.
  if (bare !== 'served') failures.push(`AC1: a declared container (audio/webm) was ${bare}`);
  if (parameterised !== 'served') {
    failures.push(`AC2: the recorder's own container (audio/webm;codecs=opus) was ${parameterised} — the match is not on the base type`);
  }
  if (upperCase !== 'served') failures.push('AC2: a declared container in another case was refused');
  if (outside !== 'refused-415-UNSUPPORTED_MIME') {
    failures.push(`AC1: a container outside the declaration was ${outside}, not refused with UNSUPPORTED_MIME at 415`);
  }

  // AC3 and AC7.
  if (oversize !== 'refused-413-OVERSIZE') {
    failures.push(`AC3: an upload past the provider budget was ${oversize}, not refused with OVERSIZE at 413`);
  }
  if (atBudget !== 'served') failures.push(`AC3: an upload exactly at the budget was ${atBudget}`);
  if (value.outside?.upstreamCalls !== 0) {
    failures.push(`AC7: an unsupported container cost ${value.outside?.upstreamCalls} upstream call(s)`);
  }
  if (value.oversize?.upstreamCalls !== 0) {
    failures.push(`AC7: an oversize upload cost ${value.oversize?.upstreamCalls} upstream call(s)`);
  }
  if (value.atBudget?.upstreamCalls !== 1) {
    failures.push('AC7 control: an upload inside the budget did not reach the backend exactly once');
  }

  // AC10: an unread count is not a zero. The reader always produces a number here, so anything
  // else means the attempt never ran — which must not read as "no upstream call was made".
  for (const key of ['bare', 'parameterised', 'upperCase', 'outside', 'oversize', 'atBudget']) {
    if (typeof value[key]?.upstreamCalls !== 'number') {
      failures.push(`AC10: the upstream call count for '${key}' is not a reading`);
    }
  }

  // AC5: the two gates follow the declaration they are handed. This is the adapter's refusal and
  // not the transport ceiling's — a hardcoded figure inside either gate moves none of these four.
  const switching = value.switch;
  const switched = switching?.containerRefused === true
    && switching?.containerAccepted === true
    && switching?.budgetRefused === true
    && switching?.budgetAccepted === true;
  if (!switched) {
    failures.push('AC5: the gates did not follow the declaration they were handed (a hardcoded whitelist or budget)');
  }

  // AC3, the transport layer: a size refusal is 413, and everything else the parser can report is
  // still 400. Read together, because "413 for every parser failure" is as wrong as "400 for both".
  // The status half is GOAL-008's reading and is unchanged; the code half moved with GOAL-011's
  // failure contract (AC-150) — every refusal the transcription path answers now names a vocabulary
  // member, so the control reads that the non-ceiling branch carries one AND that it is not the
  // ceiling's `OVERSIZE`, which is the distinction this pair exists to keep.
  const ceiling = value.transportCeiling;
  const other = value.transportOther;
  const ceilingStatus = ceiling?.status === 413 && ceiling?.body?.code === 'OVERSIZE';
  const otherStatus = other?.status === 400
    && typeof other?.body?.code === 'string'
    && other.body.code !== 'OVERSIZE';
  if (!ceilingStatus) {
    failures.push(`AC3: the transport ceiling answered ${ceiling?.status}/${ceiling?.body?.code ?? 'no code'}, not 413/OVERSIZE`);
  }
  if (!otherStatus) {
    failures.push(
      `AC3 control: a non-ceiling parser failure answered ${other?.status}/${other?.body?.code ?? 'no code'}, not 400/a non-OVERSIZE code`,
    );
  }

  return {
    readings: {
      'declared-container-bare': bare,
      'declared-container-parameterised': parameterised,
      'declared-container-case': upperCase,
      'outside-container': outside,
      'outside-container-upstream-calls': String(value.outside?.upstreamCalls),
      oversize,
      'oversize-upstream-calls': String(value.oversize?.upstreamCalls),
      'inside-budget': atBudget,
      'provider-switch-container': switching?.containerRefused === true && switching?.containerAccepted === true ? 'follows-declaration' : 'constant',
      'provider-switch-budget': switching?.budgetRefused === true && switching?.budgetAccepted === true ? 'follows-declaration' : 'constant',
      'transport-ceiling': `${ceiling?.status}/${ceiling?.body?.code ?? 'no code'}`,
      'transport-non-ceiling': `${other?.status}/${other?.body?.code ?? 'no code'}`,
    },
    failures,
    codes: {
      'proxy-outside-container': typeof value.outside?.result?.code === 'string' ? value.outside.result.code : '',
    },
  };
}

/**
 * @param {unknown} reading the client reader's payload
 * @param {Record<string, string>} serverCodes the proxy face's codes, for the AC4 comparison
 * @returns {{ readings: Record<string, string>, failures: string[] }}
 */
function clientReadings(reading, serverCodes) {
  /** @type {string[]} */
  const failures = [];
  const value = /** @type {any} */ (reading);

  const declared = value.declared;
  const parameterised = value.parameterised;
  const outside = value.outside;

  if (declared?.status !== 200) failures.push(`AC4: the direct face refused a declared container (${declared?.status})`);
  if (parameterised?.status !== 200) {
    failures.push(`AC4: the direct face refused the recorder's own container (${parameterised?.status}) — the match is not on the base type`);
  }
  if (outside?.status !== 415 || outside?.code !== 'UNSUPPORTED_MIME') {
    failures.push(`AC1 direct face: an unsupported container was ${outside?.status}/${outside?.code ?? 'no code'}`);
  }
  if (outside?.upstreamCalls !== 0) {
    failures.push(`AC7 direct face: an unsupported container cost ${outside?.upstreamCalls} upstream call(s)`);
  }
  if (typeof outside?.upstreamCalls !== 'number') {
    failures.push('AC10: the direct face upstream call count is not a reading');
  }

  // AC4: one code, both faces. Compared as strings the two readers produced in the same run, so a
  // path that refused with a different word is red even though each half looked right alone.
  const directCode = typeof outside?.code === 'string' ? outside.code : '';
  const proxyCode = serverCodes['proxy-outside-container'] ?? '';
  const sameCode = directCode !== '' && directCode === proxyCode;
  if (!sameCode) {
    failures.push(`AC4: the direct face refused with '${directCode || 'nothing'}' and the proxy face with '${proxyCode || 'nothing'}'`);
  }

  return {
    readings: {
      'direct-declared-container': `${declared?.status}`,
      'direct-parameterised-container': `${parameterised?.status}`,
      'direct-outside-container': `${outside?.status}/${outside?.code ?? 'no code'}`,
      'direct-outside-container-upstream-calls': String(outside?.upstreamCalls),
      'two-paths-same-code': sameCode ? `yes-${directCode}` : 'no',
    },
    failures,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : REPO_ROOT);
  const landingOnly = argv.includes('--landing');

  const landing = landingReadings(root);
  /** @type {Record<string, string>} */
  const readings = { ...landing.readings };
  const failures = [...landing.failures];

  if (!landingOnly) {
    const sources = sourceReadings(root);
    Object.assign(readings, sources.readings);
    failures.push(...sources.failures);

    const server = readBehaviour(root, SERVER_TSCONFIG, serverReaderSource(root));
    /** @type {Record<string, string>} */
    let codes = {};
    if (server.error) {
      failures.push(`reading: ${server.error}`);
      readings['server-reading'] = 'unavailable';
    } else {
      const behavioural = serverReadings(server.value);
      Object.assign(readings, behavioural.readings);
      failures.push(...behavioural.failures);
      codes = behavioural.codes;
    }

    const client = readBehaviour(root, ROOT_TSCONFIG, clientReaderSource(root));
    if (client.error) {
      failures.push(`reading: ${client.error}`);
      readings['client-reading'] = 'unavailable';
    } else {
      const behavioural = clientReadings(client.value, codes);
      Object.assign(readings, behavioural.readings);
      failures.push(...behavioural.failures);
    }
  }

  for (const [key, value] of Object.entries(readings)) {
    process.stdout.write(`${key}=${value}\n`);
  }
  for (const failure of failures) {
    process.stdout.write(`failure=${failure}\n`);
  }
  process.stdout.write(`verdict=${failures.length ? 'fail' : 'pass'}\n`);

  process.exit(failures.length ? 1 : 0);
}

// Only when run as the entry point: the falsification controls import this module for
// `buildFixture`, and an import that started a probe run would read the tree under the test
// rather than the fixture it built.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
