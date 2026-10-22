#!/usr/bin/env node
/**
 * The probe for the health reading and the unregistered-provider rule (AC-134).
 *
 * WHAT IT IS ASKING. Two questions, and both are about a state that used to be undefined rather
 * than about a field having appeared:
 *
 *   1. Does the health reading answer with the *user's* effective configuration? The case that
 *      matters is a server process with no voice environment at all serving a user who
 *      configured everything — the reading this endpoint got wrong.
 *   2. What happens to an id no adapter claims? It must be refused with an explicit error on
 *      every face — direct, proxy, health — and never replaced by the default provider.
 *
 * HOW IT READS THEM. The static readings are text reads of the tree it is pointed at, so they
 * work on a fixture the falsification controls have mutated. The behavioural reading drives the
 * tree's OWN modules: a reader is written to a temporary directory, `tsx` loads the tree's
 * `voice.service.ts` and `asrRegistry.ts` from it by absolute path, and the service is
 * constructed and called there. Driving the real modules is the point — a probe that re-derived
 * the answers from the source text could only ever confirm its own re-derivation.
 *
 * The reader lives outside the tree it reads, so a run leaves the tree byte-identical.
 *
 * READINGS (one `key=value` line each, then a verdict):
 *   landing, landing-candidate, server-compiles-landing   — the ADR-004 decision 3 landing
 *   registry-providers                                    — what the registry hands out
 *   health-user-configured, health-empty-configured       — AC1
 *   health-providers-match-registry                       — AC2
 *   health-unknown-provider, proxy-unknown-provider        — AC3, health and proxy faces
 *   proxy-registered-provider                             — AC3's positive control
 *   configured-field-present                              — AC4
 *   client-capability-table, client-read-points           — AC6
 *
 * --landing prints only the landing readings. AC7 is the assertion that the landing is
 * candidate (a): a health reading is a server route change, and a registry that landed somewhere
 * the server cannot compile would make the whole task unlandable rather than merely wrong.
 *
 * Run with: node scripts/asr-health-provider-check.mjs [--root <tree>] [--landing]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** The service the behavioural reading drives, and the instrumentation it is driven with. */
const SERVICE_MODULE = 'server/modules/voice/voice.service.ts';
const TYPES_MODULE = 'server/shared/types.ts';
const SERVER_TSCONFIG = 'server/tsconfig.json';
const TRANSCRIPTION_WIRE_MODULE = 'shared/asr/transcriptionWire.ts';
const MULTIMODAL_MODULE = 'shared/asr/list/multimodal/multimodal.asr-provider.ts';
const OPENAI_COMPATIBLE_MODULE = 'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts';
/**
 * The other two adapters the landing registry imports.
 *
 * THEY ARE HERE BECAUSE THIS LIST IS "EVERY FILE THIS PROBE READS", AND THE REGISTRY READS THEM.
 * A fixture built from the eight modules above cannot load `shared/asr/asrRegistry.ts` at all: the
 * module imports four adapters, and the two absent ones make the import throw — so the behavioural
 * reading, which is the one thing this probe exists to take, came back `unavailable` on every
 * fixture. That is a fixture that cannot produce the readings the falsification controls mutate, and
 * it reads exactly like a probe that is red for everything.
 */
const DASHSCOPE_OMNI_MODULE = 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';
// The relay row is a sixth registry import. It shares the E adapter's module for its endpoint and
// credential helpers, so both files have to be in the fixture; without it the registry cannot load.
const DASHSCOPE_OMNI_RELAY_MODULE = 'shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts';
const SENSEVOICE_LOCAL_MODULE = 'shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts';

/**
 * Every file this probe reads. A fixture built from these is the smallest tree all of its
 * readings can be produced from, which is what the falsification controls mutate one file at a
 * time.
 *
 * EVERY module the landing registry imports is here, not merely the one a reading is about: the
 * behavioural reading loads the registry by absolute path and the registry imports its adapters,
 * so an adapter missing from the fixture makes the registry fail to load — and a fixture that
 * cannot load produces no readings at all rather than the readings the controls are mutating.
 */
export const FIXTURE_FILES = [
  SERVER_TSCONFIG,
  TYPES_MODULE,
  SERVICE_MODULE,
  // The settings/rules contract the service imports through its `@shared` alias. This is the one
  // edge the shared-subtree closure cannot derive — that helper follows relative specifiers only,
  // and an alias is a build-time mapping — so a fixture without it cannot load the service at all:
  // the import throws, the reader prints nothing, and every behavioural reading is `unavailable`.
  'shared/voice/voiceSettingsRegistry.ts',
  // The service's runtime siblings: it composes the capture seam and re-exports the browser
  // recogniser's asset surface from these two named modules (the concern split in
  // `gap-voice-service-concern-split`). A fixture without them cannot load the service at all, so
  // every reading would come back empty rather than measured.
  'server/modules/voice/voice-service-capture.ts',
  'server/modules/voice/voice-service-transcribe.ts',
  LANDING_MODULE,
  OPENAI_COMPATIBLE_MODULE,
  MULTIMODAL_MODULE,
  DASHSCOPE_OMNI_MODULE,
  DASHSCOPE_OMNI_RELAY_MODULE,
  SENSEVOICE_LOCAL_MODULE,
  TRANSCRIPTION_WIRE_MODULE,
  'src/shared/api.ts',
  'src/modules/chat/hooks/useVoiceAvailable.ts',
];

/**
 * The capability names a client-side declaration would have to spell out.
 *
 * Read as "this tree keeps its own opinion about what a recogniser can do". The client is
 * allowed to consume the health payload's capabilities; declaring one itself is what AC6
 * forbids, because that is the copy that goes stale when a provider changes.
 */
const CAPABILITY_DECLARATION = /\b(acceptsMime|maxInlineRequestBytes|pauseCues|oversize|billing|oneShot)\s*:/;

/**
 * `source` with its comments removed, leaving string and template literals (and their contents)
 * byte-for-byte intact.
 *
 * WHY THE DECLARATION SCAN IS COMMENT-BLIND. The capability names above are also the words a
 * comment uses to EXPLAIN the registry — `src/shared/voiceTrim.ts` documents that a relay
 * recogniser declares `pauseCues: 'neutral'`, which is a true statement about
 * `shared/asr/.../dashscope-omni-relay.asr-provider.ts`, not a client-side capability table.
 * Scanning raw text read that sentence as a declaration and red the probe on 2026-10-22
 * (`87a4199ab`, one JSDoc line, no behavioural change). A reading that flips on prose is not
 * reading the invariant it claims to read.
 *
 * WHY NOT A REGEX REPLACEMENT. `source.replace(/\/\/.*$/gm, '')` truncates every URL at its
 * scheme (`https://…`) and turns string contents into code, which would trade this false
 * positive for false negatives. So this walks the source one character at a time and only drops
 * comment syntax found in CODE position: quotes and backticks toggle a literal state in which
 * `//` is just text, a `/` that can begin a regex is consumed as a regex (its character class may
 * contain quotes), and removed comments are replaced by a space so two tokens cannot fuse.
 * Newlines survive, so line structure is unchanged.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  /** @type {string[]} */
  const out = [];
  // The delimiter of the literal we are inside, or '' in code position.
  let quote = '';
  // The last non-whitespace character emitted in code position, used to tell a regex literal
  // (`/…/` after `=`, `(`, `,`, …) from division (after an identifier or a closing bracket).
  let previous = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out.push(char);
      if (char === '\\' && index + 1 < source.length) {
        // An escaped pair stays together, including an escaped delimiter.
        out.push(source[index + 1]);
        index += 2;
        continue;
      }
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out.push(char);
      previous = char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      out.push(' ');
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      out.push(' ');
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out.push('\n');
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%^~<>]/.test(previous))) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === '\\') { cursor += 2; continue; }
        if (inner === '\n') break;
        if (inner === '[') { inClass = true; cursor += 1; continue; }
        if (inner === ']') { inClass = false; cursor += 1; continue; }
        if (inner === '/' && !inClass) { closed = true; cursor += 1; break; }
        cursor += 1;
      }
      if (closed) {
        while (cursor < source.length && /[a-z]/i.test(source[cursor])) cursor += 1;
        out.push(source.slice(index, cursor));
        previous = '/';
        index = cursor;
        continue;
      }
    }
    out.push(char);
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return out.join('');
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
 * Every `.ts`/`.tsx` file under a directory, as paths relative to `root`.
 * @param {string} root
 * @param {string} directory
 * @returns {string[]}
 */
function sourceFiles(root, directory) {
  const start = path.join(root, directory);
  if (!existsSync(start)) {
    return [];
  }

  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(root, full));
    }
  };
  walk(start);
  return found;
}

/**
 * The reader the behavioural reading is produced by.
 *
 * It is generated per run because it carries the tree to read. It is written to a temporary
 * directory rather than into the tree, so running the probe cannot change what the next reading
 * sees.
 * @param {string} root absolute path of the tree under test
 * @returns {string}
 */
function readerSource(root) {
  return `const root = ${JSON.stringify(root)};
const service = await import(root + '/${SERVICE_MODULE}');
const registry = await import(root + '/${LANDING_MODULE}');

const NO_USER_SETTINGS = { baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' };
const USER_SETTINGS = { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-user', sttModel: 'whisper-large-v3', ttsModel: '', ttsVoice: '', ttsFormat: '' };
const SERVER_DEFAULTS = { baseUrl: '', apiKey: '', sttModel: 'whisper-1', ttsModel: 'tts-1', ttsVoice: 'alloy', providerId: '' };

const sent = [];
const fetchBackend = async (url) => { sent.push(url); return new Response(JSON.stringify({ text: 'ok' }), { status: 200 }); };
const audio = () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm', fileName: 'a.webm' });

const reading = { registry: { ids: registry.listProviders().map((provider) => provider.id) } };

const serviceUnderTest = service.createVoiceService({ defaults: { ...SERVER_DEFAULTS }, timeoutMs: 1000, fetchBackend });
reading.healthUser = serviceUnderTest.getHealth({ settings: USER_SETTINGS });
reading.healthEmpty = serviceUnderTest.getHealth({ settings: NO_USER_SETTINGS });
reading.registryProviders = registry.listProviders().map((provider) => ({ id: provider.id, label: provider.id, capabilities: provider.capabilities }));

// An id nothing claims, arriving from the server's own configuration: the health face.
const unknownDefault = service.createVoiceService({ defaults: { ...SERVER_DEFAULTS, baseUrl: 'https://voice.example/v1', providerId: 'multimodal-v2' }, timeoutMs: 1000, fetchBackend });
reading.healthUnknown = unknownDefault.getHealth({ settings: USER_SETTINGS });

// The proxy face: the same unregistered id, this time carried by the request, then a registered
// id through the same service so the refusal cannot be "everything is refused".
const proxy = service.createVoiceService({ defaults: { ...SERVER_DEFAULTS, baseUrl: 'https://voice.example/v1', apiKey: 'sk-server' }, timeoutMs: 1000, fetchBackend });
const before = sent.length;
reading.proxyUnknown = { result: await proxy.transcribe({ audio: audio(), overrides: { providerId: 'multimodal-v2' } }), sent: 0 };
reading.proxyUnknown.sent = sent.length - before;
const beforeRegistered = sent.length;
reading.proxyRegistered = { result: await proxy.transcribe({ audio: audio(), overrides: { providerId: registry.listProviders()[0].id } }), sent: 0 };
reading.proxyRegistered.sent = sent.length - beforeRegistered;

process.stdout.write('ASR_HEALTH_READING ' + JSON.stringify(reading) + '\\n');
`;
}

/**
 * Runs the reader against `root` and returns the reading it printed.
 * @param {string} root
 * @returns {{ value: unknown, error: string | null }}
 */
function readBehaviour(root) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'asr-health-probe-'));
  try {
    const readerPath = path.join(directory, 'reader.mjs');
    writeFileSync(readerPath, readerSource(root));
    const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const result = spawnSync(
      tsx,
      ['--tsconfig', path.join(root, SERVER_TSCONFIG), readerPath],
      { encoding: 'utf8', cwd: root },
    );
    const line = (result.stdout || '').split('\n').find((entry) => entry.startsWith('ASR_HEALTH_READING '));
    if (!line) {
      const detail = (result.stderr || '').trim().split('\n').slice(-3).join(' | ');
      return { value: null, error: `the reader produced no reading (exit ${result.status}): ${detail}` };
    }
    return { value: JSON.parse(line.slice('ASR_HEALTH_READING '.length)), error: null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The landing readings: where the registry lives and whether the server compiles it (AC7).
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
 * @param {unknown} reading the reader's payload
 * @returns {{ readings: Record<string, string>, failures: string[] }}
 */
function behaviouralReadings(reading) {
  const failures = [];
  const value = /** @type {any} */ (reading);

  const healthUser = value.healthUser;
  const userConfigured = healthUser?.ok === true && healthUser.value?.configured === true;
  if (!userConfigured) failures.push('AC1: a user-configured backend did not read as configured');

  const healthEmpty = value.healthEmpty;
  const emptyConfigured = healthEmpty?.ok === true && healthEmpty.value?.configured === true;
  if (emptyConfigured) failures.push('AC1: an unconfigured link read as configured');

  // AC2, compared against the registry the same run read rather than against a literal here.
  // Field by field for each provider, not a whole-payload equality: the payload wraps each
  // declaration with the entry's own `configured`, which is a reading about this user rather
  // than something the registry says about itself.
  /** @type {{ id: string, capabilities: unknown }[]} */
  const declared = value.registryProviders ?? [];
  /** @type {{ id: string, capabilities: unknown }[]} */
  const published = healthUser?.ok === true ? healthUser.value?.providers ?? [] : [];
  const declaredById = new Map(declared.map((provider) => [provider.id, provider]));
  const sameIds = declared.length > 0
    && declared.length === published.length
    && published.every((provider) => declaredById.has(provider.id));
  const matchesRegistry = sameIds && published.every((provider) => {
    const source = declaredById.get(provider.id);
    return source !== undefined
      && JSON.stringify(provider.capabilities) === JSON.stringify(source.capabilities);
  });
  if (!declared.length) failures.push('AC2: the registry handed out no providers');
  else if (!matchesRegistry) failures.push('AC2: the payload\'s providers do not match the registry');

  const healthUnknown = value.healthUnknown;
  const refusedByHealth = healthUnknown?.ok === false && /multimodal-v2/.test(String(healthUnknown.error));
  if (!refusedByHealth) failures.push('AC3 health face: an unregistered effective provider id was not refused by name');

  const proxyUnknown = value.proxyUnknown;
  const refusedByProxy = proxyUnknown?.result?.ok === false && proxyUnknown.sent === 0;
  if (proxyUnknown?.result?.ok === true) failures.push('AC3 proxy face: an unregistered id was served anyway (silent fallback)');
  else if (!refusedByProxy) failures.push('AC3 proxy face: an unregistered id was refused but a request still went out');

  const proxyRegistered = value.proxyRegistered;
  if (proxyRegistered?.result?.ok !== true || proxyRegistered.sent !== 1) {
    failures.push('AC3 control: a registered provider id did not reach the backend');
  }

  // AC4, spelled the way the consumer spells it: `data?.configured === true`.
  const configuredFieldPresent = healthUser?.ok === true && healthUser.value?.configured === true;
  if (!configuredFieldPresent) failures.push('AC4: the payload no longer carries a readable `configured`');

  return {
    readings: {
      'registry-providers': declared.map((provider) => provider.id).join(',') || 'none',
      'health-user-configured': String(userConfigured),
      'health-empty-configured': String(emptyConfigured),
      'health-providers-match-registry': matchesRegistry ? 'yes' : 'no',
      'health-unknown-provider': healthUnknown?.ok === false ? `refused-${healthUnknown.status}` : 'served',
      'proxy-unknown-provider': proxyUnknown?.result?.ok === true
        ? 'served-by-a-fallback'
        : proxyUnknown?.sent === 0 ? `refused-${proxyUnknown?.result?.status}-no-fetch` : 'refused-but-sent',
      'proxy-registered-provider': proxyRegistered?.result?.ok === true ? `sent-${proxyRegistered.sent}` : 'not-sent',
      'configured-field-present': configuredFieldPresent ? 'yes' : 'missing',
    },
    failures,
  };
}

/**
 * The client's half: which symbols read capabilities, and whether the tree keeps its own
 * declaration of them (AC6).
 * @param {string} root
 * @returns {{ readings: Record<string, string>, failures: string[] }}
 */
function clientReadings(root) {
  /** @type {string[]} */
  const failures = [];
  const files = sourceFiles(root, 'src');
  // Strip comments before matching: a capability name in prose describes a declaration, it is not
  // one. The code in the same file is read unchanged, so a real table is still caught.
  const declaring = files.filter((file) => CAPABILITY_DECLARATION.test(stripComments(readTreeFile(root, file))));

  // The two symbols the client's capability path runs through: the variable that holds the
  // health reading's provider, and the hook call that fills it.
  const api = readTreeFileOrEmpty(root, 'src/shared/api.ts');
  const hook = readTreeFileOrEmpty(root, 'src/modules/chat/hooks/useVoiceAvailable.ts');
  const readPoints = [];
  if (/voiceProviderProfile/.test(api)) readPoints.push('voiceProviderProfile');
  if (/setVoiceProviderProfile\(/.test(hook)) readPoints.push('setVoiceProviderProfile');
  const readsRegistry = /tryResolve/.test(api) && /@shared\/asr\/asrRegistry/.test(api);

  if (declaring.length) {
    failures.push(`AC6: the client declares capabilities of its own in ${declaring.join(', ')}`);
  }
  if (!readsRegistry) failures.push('AC6: the client does not ask the registry whether an id exists');
  if (readPoints.length !== 2) failures.push('AC6: the client capability read points are not the published profile');

  return {
    readings: {
      'client-capability-table': declaring.length ? `declared-in-${declaring.length}-file(s)` : 'none',
      'client-read-points': readPoints.join(',') || 'none',
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
    const behaviour = readBehaviour(root);
    if (behaviour.error) {
      failures.push(`reading: ${behaviour.error}`);
      readings['behavioural-reading'] = 'unavailable';
    } else {
      const behavioural = behaviouralReadings(behaviour.value);
      Object.assign(readings, behavioural.readings);
      failures.push(...behavioural.failures);
    }

    const client = clientReadings(root);
    Object.assign(readings, client.readings);
    failures.push(...client.failures);
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
// `FIXTURE_FILES`, and an import that started a probe run would read the tree under the test
// rather than the fixture it built.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
