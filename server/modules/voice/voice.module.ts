import path from 'node:path';

import multer from 'multer';

import { voiceSettingsDb } from '@/modules/database/index.js';
import type { VoiceLogPort, VoiceSettings } from '@/shared/types.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

// The provider address book, read here for the one figure the transport layer can know without
// knowing which provider will serve the request: the ceiling above every declared budget.
import { listProviders } from '../../../shared/asr/asrRegistry.js';
import { installSensevoiceEngine } from '../../../shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.js';

import {
  announceVoiceCapture,
  announceVoiceCaptureRaw,
  createVoiceCapture,
  createVoiceCaptureAudioSink,
  resolveInstanceSalt,
  resolveVoiceCaptureDir,
  voiceCaptureDirStartupLine,
} from './voice-capture.js';
import { createVoiceClientAssetsRouter, createVoiceRouter } from './voice.routes.js';
import {
  createVoiceDataStore,
  resolveVoiceDataDir,
  voiceDataDirStartupLine,
} from './voice-data.js';
import { voiceLexicon } from './voice-lexicon.js';
import { createVoiceClientAssetsService, createVoiceService, createVoiceSettingsService } from './voice.service.js';
import {
  createSensevoiceWorker,
  nodeSensevoiceSpawn,
  readSensevoiceManifest,
  sensevoiceLogFrom,
  unavailableSensevoiceEngine,
} from './sensevoice-worker.js';

/**
 * Where this deployment's own voice lines go.
 *
 * Resolved ONCE, here, because the start-up line below and every attempt line after it have to reach
 * the same place: a process that announced its recording mode on one stream and wrote its attempts
 * to another would have made the announcement unreadable to exactly the reader who needs it. The
 * service keeps its own `console` fallback for callers that wire no port (tests, probes, the
 * invariant board), so this binding changes nothing for them.
 */
const voiceLog: VoiceLogPort = console;

/**
 * The same output, in the shape the SenseVoice manager asks for.
 *
 * DERIVED ONCE RATHER THAN AT EACH SITE, because the two places this module says something about the
 * engine — the line below when the manifest cannot be read, and the manager's own log when the worker
 * starts or fails — have to reach the same stream, and a fallback rule written twice is a fallback
 * rule that can differ. See `sensevoiceLogFrom` for why the translation exists at all.
 */
const sensevoiceLog = sensevoiceLogFrom(voiceLog);

/**
 * THE ONE READ of `VOICE_CAPTURE` in this process, and the one place it is announced.
 *
 * Read at start-up and never per request, because the mode is a property of the DEPLOYMENT rather
 * than of a user or a request: a value re-read on the request path could change what is recorded
 * halfway through a recording, which is precisely the reading nobody could reconstruct afterwards.
 * An unrecognised value comes back as `off` with a warning, and the warning is written here rather
 * than swallowed — see `resolveVoiceCaptureMode` for why a misspelling fails closed.
 *
 * The resolution announced here IS the one injected below, so "the mode the process says it is in"
 * and "the mode it records in" cannot disagree.
 */
const voiceCapture = announceVoiceCapture(process.env.VOICE_CAPTURE, voiceLog);

/**
 * THE ONE READ of `VOICE_CAPTURE_RAW` in this process, and the one place it is announced.
 *
 * An INDEPENDENT switch, read once here for the same reason the mode is: it is a property of the
 * deployment, not of a request, and a value re-read per recording could change what is collected
 * halfway through a listen. It is announced BESIDE the mode line rather than folded into it, so the
 * mode announcement's own output is unchanged and a deployment that never sets this variable gains
 * exactly one line saying `enabled=0`. An unrecognised value fails closed with a warning, exactly as
 * the mode's does — see `resolveVoiceCaptureRaw`.
 */
const voiceCaptureRaw = announceVoiceCaptureRaw(process.env.VOICE_CAPTURE_RAW, voiceLog);

/**
 * THE ONE READ of `VOICE_CAPTURE_DIR` in this process, and the directory every recording goes into.
 *
 * Read here and not inside the sink for the same reason the mode is read here: the environment
 * belongs to the composition root, so "where do recordings go" has one answer that the deployment's
 * own configuration produced. Both values are handed over as arguments — `resolveVoiceCaptureDir`
 * reads no variable itself — which is what lets a criterion ask what a given pair of values means
 * without mutating the process first.
 *
 * THE DEFAULT IS BESIDE THE DATABASE, so a deployment that moved its state moved its recordings with
 * it. `DATABASE_PATH` is read here rather than reached for by a second reader of the database
 * configuration: this file is the one place that knows both.
 *
 * RESOLVING IS NOT CREATING. This runs at start-up and creates nothing; the directory appears on the
 * first recording that is actually written (see `createVoiceCaptureAudioSink`), so a deployment in
 * `off` or `text` leaves no trace on disk even when a directory is configured for it.
 */
const voiceCaptureDirectory = resolveVoiceCaptureDir(
  process.env.VOICE_CAPTURE_DIR,
  process.env.DATABASE_PATH,
);

// THE DIRECTORY IS ANNOUNCED, not just resolved, because nothing here deletes or rotates these files
// by design: the only thing that makes the growth visible is the line naming where it lands. It
// carries no file and no bytes — only the path a deployment already configured — so it discloses
// nothing a reader of the process's own configuration could not already see.
voiceLog.info(voiceCaptureDirStartupLine(voiceCaptureDirectory));

/**
 * THE ONE READ of `VOICE_DATA_DIR` in this process, and the directory the user's own dictation goes
 * into.
 *
 * THE SIBLING OF `VOICE_CAPTURE_DIR`, resolved the same way and from the same two inputs, but it
 * names the USER-DATA store rather than the diagnostic capture: default BESIDE THE DATABASE
 * (`~/.cloudcli/voice-data`), so a deployment that moved its state moved its recordings with it.
 * Resolving creates nothing — the directory appears on the first record a user's settings let
 * through — which is what keeps a user who turned recording off from leaving an empty directory
 * behind.
 *
 * IT IS ANNOUNCED, like the capture directory and for the same reason: an operator has to be able to
 * see where a user's own audio and text landed. Unlike the capture directory, this store DOES rotate
 * itself (see its capacity ceiling), so the line is the map rather than a growth warning.
 */
const voiceDataDirectory = resolveVoiceDataDir(process.env.VOICE_DATA_DIR, process.env.DATABASE_PATH);
voiceLog.info(voiceDataDirStartupLine(voiceDataDirectory));

/**
 * How long any one voice request may take, when the deployment names no figure.
 *
 * DECLARED HERE, ABOVE THE SENSEVOICE BLOCK, rather than beside the service that reads it below.
 * The on-host recogniser's own timeout defaults to this one, and a default that read a `const` from
 * further down the module would be in its temporal dead zone at module evaluation — the block below
 * runs eagerly, so "which line comes first" is a correctness property here and not a style choice.
 * The service's own use of the same figure is unaffected: this is the same binding, moved up.
 */
const DEFAULT_VOICE_TIMEOUT_MS = 300_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

/**
 * THE ONE READ of the `SENSEVOICE_*` variables in this process, and the one place the on-host
 * recogniser's engine is built.
 *
 * IT FOLLOWS THE RULE THIS FILE ALREADY KEEPS FOR `VOICE_CAPTURE_DIR` AND `VOICE_DATA_DIR`: the
 * environment belongs to the composition root, so "where are the weights, which interpreter runs
 * them, how many requests may be in flight" has one answer that the deployment's own configuration
 * produced. `createSensevoiceWorker` reads no variable itself — every value below is handed to it —
 * which is what lets a test build a worker over a fake child without mutating the process first.
 *
 * IT SPAWNS NOTHING. This runs at module evaluation and only stats two files; the Python process
 * appears when a request actually selects `sensevoice-local` (see `createSensevoiceWorker`). A
 * deployment that never uses this recogniser therefore pays two `statSync` calls and no memory.
 *
 * ABSENT CONFIGURATION IS A STATE, NOT A CRASH. `SENSEVOICE_MODEL_DIR` unset is the ordinary case
 * for every deployment that does not use this recogniser, and it is reported rather than thrown:
 * the engine is installed in its unavailable form with the reason, `GET /api/voice/health` answers
 * `ENGINE_UNAVAILABLE` with that sentence, and nothing about the other three providers changes.
 */
const sensevoiceApplicationRoot = findApplicationRoot(getModuleDirectory(import.meta.url));

/** How many requests one worker serves at once, when the deployment names no figure. */
const DEFAULT_SENSEVOICE_CONCURRENCY = 2;
const parsedSensevoiceConcurrency = Number(process.env.SENSEVOICE_CONCURRENCY);
const sensevoiceConcurrency =
  Number.isInteger(parsedSensevoiceConcurrency) && parsedSensevoiceConcurrency >= 1
    ? parsedSensevoiceConcurrency
    : DEFAULT_SENSEVOICE_CONCURRENCY;

const parsedSensevoiceTimeoutMs = Number(process.env.SENSEVOICE_TIMEOUT_MS);
const sensevoiceTimeoutMs =
  Number.isFinite(parsedSensevoiceTimeoutMs) && parsedSensevoiceTimeoutMs > 0
    ? parsedSensevoiceTimeoutMs
    : voiceTimeoutMs;

const sensevoiceEngine = ((): ReturnType<typeof createSensevoiceWorker> | null => {
  const modelDir = (process.env.SENSEVOICE_MODEL_DIR || '').trim();
  const python = (process.env.SENSEVOICE_PYTHON || '').trim() || 'python3';
  const pythonPath = (process.env.SENSEVOICE_PYTHONPATH || '').trim() || null;
  const workerPath = (process.env.SENSEVOICE_WORKER || '').trim()
    || path.join(sensevoiceApplicationRoot, 'scripts', 'sensevoice', 'worker.py');
  const manifestPath = (process.env.SENSEVOICE_MANIFEST || '').trim()
    || path.join(sensevoiceApplicationRoot, 'scripts', 'sensevoice', 'manifest.json');

  let manifest;
  try {
    manifest = readSensevoiceManifest(manifestPath);
  } catch (error) {
    // A manifest that cannot be read leaves the engine's IDENTITY unknown, and an engine whose
    // identity is unknown is not one this deployment may report a build for. It is installed in its
    // unavailable form carrying the parse failure, rather than omitted — see
    // `unavailableSensevoiceEngine` for why the reason has to survive.
    const reason = `the SenseVoice manifest at ${manifestPath} could not be read: ${String(error)}`;
    sensevoiceLog.warn(`sensevoice: ${reason}`);
    installSensevoiceEngine(unavailableSensevoiceEngine(reason));
    return null;
  }

  const engine = createSensevoiceWorker({
    manifest,
    modelDir: modelDir === '' ? null : modelDir,
    python,
    pythonPath,
    workerPath,
    concurrency: sensevoiceConcurrency,
    timeoutMs: sensevoiceTimeoutMs,
    spawn: nodeSensevoiceSpawn,
    log: sensevoiceLog,
  });
  installSensevoiceEngine(engine);
  return engine;
})();

// ANNOUNCED, like the two directories above and for the same reason: whether this recogniser can
// run at all is a property of the deployment, and the line is the only place an operator learns it
// without making a request. It carries the model directory and the pinned build id — both of which
// are already in the process's own configuration — and never a transcript.
{
  const state = sensevoiceEngine?.status() ?? null;
  const modelDir = (process.env.SENSEVOICE_MODEL_DIR || '').trim();
  voiceLog.info(
    state !== null && state.available
      ? `sensevoice engine: ready to start (build ${state.buildId}, model dir ${modelDir || '<unset>'})`
      : `sensevoice engine: unavailable (${state !== null && !state.available ? state.reason : 'the manifest could not be read'})`,
  );
}

/**
 * The instant this process came up, for the one figure the attempt ids rest on.
 *
 * `Date.now()` AT MODULE EVALUATION is the closest this side has to "when did this instance start":
 * the composition root is evaluated once, at start-up, and the salt below is a function of THIS
 * value. Paired with the pid (see `resolveInstanceSalt`), it names the INSTANCE rather than the
 * machine, so a restart — even one the kernel hands the same recycled pid — gets a new salt and
 * therefore a new family of attempt ids. Read here rather than inside the capture module for the same
 * reason the mode and the directory are: the composition root is the one reader of the process's own
 * identity, and the factory is handed the token it should mint ids from.
 */
const voiceStartedAtMs = Date.now();

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: frontend-configured custom
    // backends are called directly by the browser and never become SSRF input.
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
    // The deployment's preferred recogniser. Empty — the usual case — means the registry's
    // first entry, so a deployment that never sets this variable keeps working across a
    // provider being renamed. An id no adapter claims is refused, not replaced.
    providerId: (process.env.VOICE_PROVIDER_ID || '').trim(),
  },
  timeoutMs: voiceTimeoutMs,
  // The recording seam, built from the mode this process resolved above. It is ALWAYS injected —
  // including for `off`, where the port records nothing — so that the decision to record lives in
  // one place inside the service rather than in a ternary here: a root that omitted the port for
  // `off` would leave "the service is off" untested by the only deployment shape that matters.
  //
  // The audio sink, wired into the same call as the mode it is gated by. The gate is the port's own
  // (`recordAttempt` writes only when the mode is `audio`), and the sink is left as a dependency of
  // the port rather than of the service, so nothing above this line knows that `audio` mode exists.
  //
  // It is wired for EVERY mode, `off` and `text` included, and that is deliberate: a deployment whose
  // sink was omitted for the modes that do not use it would be testing the omission rather than the
  // gate. The directory is resolved above and simply not reached — see `voiceCaptureDirectory`.
  capture: createVoiceCapture({
    mode: voiceCapture.mode,
    log: voiceLog,
    // The instance salt, derived from THIS process's own identity and read once: the id it produces
    // is what keeps one run's recordings from colliding with a previous run's. See `voice-capture.ts`.
    instanceSalt: resolveInstanceSalt(process.pid, voiceStartedAtMs),
    audio: createVoiceCaptureAudioSink({ directory: voiceCaptureDirectory }),
    // The raw switch, read once above and handed to the port that acts on it. It is INDEPENDENT of
    // the mode, so `VOICE_CAPTURE_RAW=1` with no mode still collects the raw corpus — the switch
    // decides only whether the pre-VAD bytes are kept, never where the trimmed rows go.
    raw: voiceCaptureRaw.enabled,
  }),
  // THE USER-DATA STORE, a separate seam from `capture` above. It is ALWAYS wired — the D1 promise is
  // default-on, so the shipping deployment must hold a store — and its own gate (the user's
  // `voiceDataRecording` setting, read off the document the request passes it) decides per user
  // whether a record is written. Wiring it here rather than in the service is what keeps the store's
  // directory the composition root's one answer, exactly as the capture directory is.
  voiceData: createVoiceDataStore({ directory: voiceDataDirectory }),
  logger: voiceLog,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

/**
 * The transport ceiling: the largest upload ANY registered provider declares it can take.
 *
 * Derived from the registry rather than written as a number, because the two figures in this
 * layering must not be able to disagree. A literal here would be a second source of truth about
 * how big an upload may be, and the day a provider's budget moved it would silently become the
 * binding one — the provider would be handed a truncated read, or a request it could have served
 * would be refused by a parser that never knew which provider it was for.
 *
 * Because this is the maximum over the registry, it can never be smaller than the selected
 * provider's own budget, so the effective limit for one request is `min(this, that budget)` — and
 * the provider-level gate is the one that computes it, since only it knows the provider. Multer
 * runs before the handler and therefore before any provider is known; that is why this layer can
 * only be a ceiling and not the limit itself.
 *
 * An empty registry leaves the ceiling at zero, which refuses every upload rather than admitting
 * an unbounded one: nothing can serve a request in that state, so accepting bytes for it would be
 * buffering work with no destination.
 */
function transportCeilingBytes(): number {
  let ceiling = 0;
  for (const adapter of listProviders()) {
    ceiling = Math.max(ceiling, adapter.capabilities.maxInlineRequestBytes);
  }
  return ceiling;
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: transportCeilingBytes() },
});

/**
 * The raw-corpus endpoint's own upload ceiling, in bytes.
 *
 * A LITERAL RATHER THAN THE REGISTRY'S MAXIMUM, and the difference is the subject rather than a
 * shortcut: the trimmed upload's ceiling is the largest a RECOGNISER declares it can take, because
 * those bytes are sent on to one. Raw audio is sent nowhere — it is kept — so its bound is a property
 * of the corpus, not of any provider. 16 kHz mono 16-bit PCM is about 32 KB/s, so 32 MiB is roughly
 * seventeen minutes of one listen, comfortably past the client's own 600-second original cap and far
 * below the point where buffering one request would be a denial-of-service of its own.
 */
const RAW_UPLOAD_CEILING_BYTES = 32 * 1024 * 1024;

const rawAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RAW_UPLOAD_CEILING_BYTES },
});

// The settings the user saved, read and written through the Voice settings
// routes. Stored per user so a key no longer lives only in one browser profile.
const voiceSettingsService = createVoiceSettingsService(voiceSettingsDb);

/**
 * Reads the voice settings document one user saved.
 *
 * Consumers: `server/index.ts`'s Live Voice realtime assembly point, which needs the user's
 * DashScope key for the connection's bearer credential. It is a narrow read — not the database
 * handle — so the entry point reaches the settings row through this module's barrel instead of
 * deep-importing the database repository, and the Voice routes/services keep using the same store.
 */
export function readVoiceSettings(userId: number): VoiceSettings {
  return voiceSettingsDb.getSettings(userId);
}

/**
 * THE ONE READ of `VOICE_CLIENT_MODEL_DIR` in this process, and the directory the browser
 * recogniser's model files are served from.
 *
 * IT FALLS BACK TO `SENSEVOICE_MODEL_DIR` (see `resolveVoiceClientModelDir`), so a deployment that
 * already runs the on-host recogniser needs no new configuration at all. The runtime files come from
 * this repo's own pinned `onnxruntime-web` install under `node_modules`, so nothing about them is
 * configurable — the front end was validated against that exact distribution, and serving another
 * would be serving a runtime it was not tested with.
 */
const voiceClientAssets = createVoiceClientAssetsService({
  voiceClientModelDir: process.env.VOICE_CLIENT_MODEL_DIR,
  sensevoiceModelDir: process.env.SENSEVOICE_MODEL_DIR,
  ortDistDir: path.join(sensevoiceApplicationRoot, 'node_modules', 'onnxruntime-web', 'dist'),
});

// ANNOUNCED, like the two directories above and for the same reason: whether the browser recogniser
// can be served at all is a property of the deployment, and this line is where an operator learns it
// without opening a page. It carries the resolved directory and whether the artifacts are present —
// both already in the process's own configuration — and never a transcript.
{
  const reading = voiceClientAssets.readiness();
  voiceLog.info(
    reading.ready
      ? `voice client assets: ready (model dir ${reading.directory ?? '<unset>'})`
      : `voice client assets: unavailable (${
        reading.configured ? `the model directory ${reading.directory} is missing an artifact` : 'no model directory configured'
      })`,
  );
}

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  voiceSettingsService,
  // The U-source lexicon, whose singleton binds the database store to the session
  // index. It is the SAME instance the chat dispatch records into, so a token a
  // sent message just deposited is immediately visible to `GET /lexicon`.
  lexiconService: voiceLexicon,
  parseAudioUpload: audioUpload.single('audio'),
  // The raw endpoint's own parser, built above from its own ceiling. The router owns both routes and
  // never learns a size; which figure bounds which endpoint is decided here, at the one place that
  // knows the deployment.
  parseRawAudioUpload: rawAudioUpload.single('audio'),
  // The provisioning reading the authenticated `GET /client-assets` route republishes.
  voiceClientAssets,
});

/**
 * The UNAUTHENTICATED same-origin artifact router, mounted at `/voice-client` by `server/index.ts`.
 *
 * Exported separately from `voiceRoutes` because it is mounted OUTSIDE the authenticated
 * `/api/voice` prefix: the entry module and the `.wasm` are fetched by the browser and the runtime
 * themselves, and both must be reachable before a user has a session.
 */
export const voiceClientAssetRoutes = createVoiceClientAssetsRouter({ voiceClientAssets });
