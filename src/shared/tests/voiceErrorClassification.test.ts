/**
 * ONE CLASSIFICATION, TWO PATHS: the browser's direct path and the adapters behind the proxy route
 * have to answer the SAME upstream failure with the SAME code.
 *
 * WHY THIS IS ITS OWN FILE. An adapter has two callers — the browser addressing a recogniser
 * itself, and the server proxying it — and each caller had (or could grow) its own opinion about
 * what a `403` or a `429` means. The vocabulary, the code-string table and the classifier are one
 * implementation in `shared/asr/asrRegistry.ts`, and each half is pinned elsewhere; what nothing
 * pinned is the JOIN: that the code the shipped direct path hands the composer and the code the
 * shipped adapter returns for the same `(status, body)` pair are the same string. This file drives
 * one fixture table through three shipped seams and compares them row by row.
 *
 * THE THREE SEAMS ARE THE SHIPPED ONES — `transcribeVoice` from `src/shared/api.ts` (with a
 * stand-in `fetch`: no port, no socket, no network), and `resolve(id).transcribe(request,
 * invocation)` for the two adapters this deployment ships. Nothing here re-implements the
 * classification: a copy inside this file would make every row agree by construction and read green
 * forever, which is the failure the second falsifying form below is built to catch.
 *
 * THE FIXTURES CARRY TWO SPELLING FAMILIES. The dotted `PascalCase` codes are this service's own;
 * `invalid_api_key`, `model_not_found`, `insufficient_quota` and `rate_limit_exceeded` are the
 * OpenAI-compatible family's, and none of the four was in any table in this repository before. They
 * are rows of the ONE table now, because `insufficient_quota` and `AllocationQuota.FreeTierOnly`
 * are the same FACT (the quota is gone) reaching for the same remedy — a second table would be a
 * second answer to one question.
 *
 * WHY SOME ROWS SHARE A STATUS. A table read only by status passes every row of a table that used
 * one status per code. The rows that make the difference a READING are the ones that share a status
 * and differ in their code string: three different `400`s, and a `429` pair that splits into "slow
 * down" and "your quota is gone". `AC3` reads those groups, and the second falsifying form replaces
 * the classification with a status-only one and watches them collapse.
 *
 * THE TWO FALSIFYING FORMS LIVE IN THIS FILE on purpose: the criterion command collects exactly this
 * file, so a form written in a second file would never be driven. Both drive the SHIPPED seams, both
 * mutate in memory (module stand-ins — no temporary file, no residue, no child process), and each
 * reports the unmutated copy green first, then which row the mutant reddened, then that the rows
 * outside the predicted family stayed green.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, vi } from 'vitest';

import { listProviders, resolve, tryResolve, type AsrErrorCode, type AsrInvocation, type AsrRequest } from '@shared/asr/asrRegistry';
// Type-only NAMESPACE imports, for the `importOriginal<typeof …>()` generics below: an inline
// `import('...')` type annotation is forbidden by this repository's lint rule.
import type * as AsrRegistryModule from '@shared/asr/asrRegistry';
import type * as TranscriptionWireModule from '@shared/asr/transcriptionWire';
import { setVoiceProviderProfile, transcribeVoice } from '@/shared/api';
import { resetVoiceConfig, whenVoiceConfigReady } from '@/shared/voiceConfig';

// ── the in-memory mutation levers ────────────────────────────────────────────────────────────
//
// A `vi.mock` factory is hoisted above every import and cannot close over this file's variables, so
// the two levers are `vi.hoisted` bindings the factories read at CALL time. With both levers `null`
// the mocked modules ARE the shipped ones — the factory spreads `importOriginal()` — which is what
// makes the unmutated copy of every reading a reading of the shipping code rather than of a second
// implementation that happens to agree with it.

const lever = vi.hoisted(() => ({
  /** Overrides the shared classifier; `null` = the shipped one. */
  classify: null as null | ((status: number | undefined, body: string) => string),
  /** Overrides the shared wire's parse; `null` = the shipped one. */
  parse: null as null | ((response: Response, tolerance: string) => Promise<string>),
}));

vi.mock('@shared/asr/asrRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof AsrRegistryModule>();
  return {
    ...actual,
    classifyUpstreamFailure: (status: number | undefined, body: string): AsrErrorCode =>
      lever.classify === null
        ? actual.classifyUpstreamFailure(status, body)
        : (lever.classify(status, body) as AsrErrorCode),
  };
});

// The adapters live under the repository-root `shared/` tree and reach the registry by a RELATIVE
// `.js` specifier (`../../asrRegistry.js`), which the suite's resolver keys apart from the `@shared`
// alias above. Both specifiers are registered for the same reason two spellings of one code are two
// rows of one table: the lever has to reach the adapters too, or "the adapters follow the shared
// classifier" would be asserted against a module nothing replaced and read green whatever they did.
vi.mock('../../../shared/asr/asrRegistry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AsrRegistryModule>();
  return {
    ...actual,
    classifyUpstreamFailure: (status: number | undefined, body: string): AsrErrorCode =>
      lever.classify === null
        ? actual.classifyUpstreamFailure(status, body)
        : (lever.classify(status, body) as AsrErrorCode),
  };
});

vi.mock('@shared/asr/transcriptionWire', async (importOriginal) => {
  const actual = await importOriginal<typeof TranscriptionWireModule>();
  return {
    ...actual,
    parseTranscriptionResponse: (response: Response, tolerance: 'strict' | 'lenient'): Promise<string> =>
      lever.parse === null
        ? actual.parseTranscriptionResponse(response, tolerance)
        : lever.parse(response, tolerance),
  };
});

// ── the fixture table ────────────────────────────────────────────────────────────────────────

/**
 * Which half of the seam carries a row.
 *
 * `classifier` — the code comes from `classifyUpstreamFailure`, read off the answer's own code
 *   string with the status as the fallback. These are the rows the falsifying forms move.
 * `envelope` — a `2xx`. The classifier has no answer for a successful answer (its fallback would
 *   guess `UPSTREAM_UNAVAILABLE`), so this row is carried by the ENVELOPE reading: the adapter's
 *   own wire and the direct path's both name `NO_SPEECH_DETECTED` for a well-formed answer that says
 *   nothing. It is in the table because the two paths have to agree about a silent recording too,
 *   and it is marked apart because a mutation of the classifier cannot move it.
 */
type Family = 'classifier' | 'envelope';

type Row = {
  /** The code string the body names, as the row is printed; `(none)` for a body that names none. */
  code: string;
  status: number;
  body: string;
  expected: AsrErrorCode;
  family: Family;
  /** `true` for the row whose upstream never produced a status at all. */
  rejected?: true;
};

/** An answer body that names `code` in the `error.code` field — the spelling this family uses. */
function names(code: string, message?: string): string {
  return JSON.stringify({ error: { code, ...(message === undefined ? {} : { message }) } });
}

/** A body that names nothing code-shaped: the status fallback is what decides these. */
function bare(reason: string): string {
  return JSON.stringify({ error: reason });
}

/**
 * The rows, and the code they must all agree on.
 *
 * The OpenAI-compatible four sit beside their dotted counterparts deliberately: `invalid_api_key`
 * beside `InvalidApiKey`, `insufficient_quota` beside `AllocationQuota.FreeTierOnly`. Two spellings
 * of one fact must not become two answers, and putting them in one table is how that is read rather
 * than asserted in prose.
 */
const FIXTURES: readonly Row[] = [
  { code: 'AccessDenied.Unpurchased', status: 403, body: names('AccessDenied.Unpurchased', 'the model is not purchased'), expected: 'ACCOUNT_ACCESS', family: 'classifier' },
  { code: 'Arrearage', status: 400, body: names('Arrearage', 'the account is in arrears'), expected: 'ACCOUNT_ACCESS', family: 'classifier' },
  { code: 'InvalidApiKey', status: 401, body: names('InvalidApiKey', 'the key was refused'), expected: 'UNAUTHORIZED', family: 'classifier' },
  { code: '(none)', status: 403, body: bare('forbidden'), expected: 'UNAUTHORIZED', family: 'classifier' },
  { code: 'AllocationQuota.FreeTierOnly', status: 429, body: names('AllocationQuota.FreeTierOnly', 'the free tier is used up'), expected: 'QUOTA_EXHAUSTED', family: 'classifier' },
  { code: 'Throttling.AllocationQuota', status: 429, body: names('Throttling.AllocationQuota', 'the allocated quota is exhausted'), expected: 'QUOTA_EXHAUSTED', family: 'classifier' },
  { code: 'Throttling.RateQuota', status: 429, body: names('Throttling.RateQuota', 'slow down'), expected: 'RATE_LIMITED', family: 'classifier' },
  { code: 'ModelNotFound', status: 404, body: names('ModelNotFound', 'no such model'), expected: 'MODEL_NOT_FOUND', family: 'classifier' },
  { code: 'InvalidParameter+duration', status: 400, body: names('InvalidParameter', 'audio duration must be in 1 to 300 seconds'), expected: 'AUDIO_REJECTED', family: 'classifier' },
  { code: 'DataInspectionFailed', status: 400, body: names('DataInspectionFailed', 'the audio was flagged'), expected: 'CONTENT_FLAGGED', family: 'classifier' },
  { code: '(none)', status: 500, body: bare('internal'), expected: 'UPSTREAM_UNAVAILABLE', family: 'classifier' },
  { code: '(none)', status: 503, body: bare('unavailable'), expected: 'UPSTREAM_UNAVAILABLE', family: 'classifier' },
  { code: '(none)', status: 408, body: bare('timed out'), expected: 'UPSTREAM_UNAVAILABLE', family: 'classifier' },
  { code: '(transport-reject)', status: 0, body: '', expected: 'UPSTREAM_UNAVAILABLE', family: 'classifier', rejected: true },
  { code: '(no-instruction-no-transcript)', status: 200, body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }), expected: 'NO_SPEECH_DETECTED', family: 'envelope' },
  { code: 'invalid_api_key', status: 401, body: names('invalid_api_key', 'the key was refused'), expected: 'UNAUTHORIZED', family: 'classifier' },
  { code: 'model_not_found', status: 404, body: names('model_not_found', 'no such model'), expected: 'MODEL_NOT_FOUND', family: 'classifier' },
  { code: 'insufficient_quota', status: 429, body: names('insufficient_quota', 'the quota is gone'), expected: 'QUOTA_EXHAUSTED', family: 'classifier' },
  { code: 'rate_limit_exceeded', status: 429, body: names('rate_limit_exceeded', 'slow down'), expected: 'RATE_LIMITED', family: 'classifier' },
  { code: 'SomethingElse.New', status: 403, body: names('SomethingElse.New', 'a code this table has never seen'), expected: 'UNAUTHORIZED', family: 'classifier' },
  { code: '(none)', status: 404, body: bare('not found'), expected: 'UPSTREAM_UNAVAILABLE', family: 'classifier' },
];

const OPENAI_FAMILY = ['invalid_api_key', 'model_not_found', 'insufficient_quota', 'rate_limit_exceeded'];
const UNKNOWN_CODE_ROW = 'SomethingElse.New';
/** The statuses `AC3` reads as groups: each must hold more than one code. */
const GROUP_STATUSES = [400, 429, 404];
/** The rows that share a status AND a code — "differ" must not be an assertion over an empty set. */
const SAME_CODE_CONTROLS = ['InvalidApiKey', 'invalid_api_key', 'SomethingElse.New'];

// ── driving the shipped direct path ──────────────────────────────────────────────────────────

const CONFIG_URL = '/api/voice/config';
const BACKEND_ORIGIN = 'https://voice.example.test';
const SETTINGS = {
  baseUrl: `${BACKEND_ORIGIN}/v1`,
  apiKey: 'sk-criterion-key',
  sttModel: 'whisper-1',
  ttsModel: 'playai-tts',
  ttsVoice: 'Arista-PlayAI',
  ttsFormat: 'mp3',
};

/** What the stand-in upstream answers with, set per row before the call. */
let answer: { status: number; body: string } | 'reject' = { status: 200, body: '{}' };
/** The URLs the stand-in transport was asked for, so a mis-route is visible rather than silent. */
const requested: string[] = [];

const transport = vi.fn(async (input: unknown): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  if (url === CONFIG_URL) {
    return new Response(JSON.stringify(SETTINGS), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (answer === 'reject') {
    throw new TypeError('the transport never connected');
  }
  return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
});

/**
 * Puts the shipped direct path in a drivable state: the settings hydrated from the stand-in server,
 * the profile the health reading would publish, and no network anywhere.
 */
async function armDirectPath(): Promise<void> {
  resetVoiceConfig();
  setVoiceProviderProfile(null);
  vi.stubGlobal('fetch', transport);
  await whenVoiceConfigReady();

  const shipped = listProviders()[0];
  if (shipped === undefined) {
    throw new Error('the registry hands out no provider: the direct path cannot be aimed at one');
  }
  setVoiceProviderProfile({ id: shipped.id, capabilities: shipped.capabilities });
}

/** The code an answer carries, or `null` when it carries none — read from a copy, never the answer. */
async function codeIn(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return typeof body?.code === 'string' && body.code !== '' ? body.code : null;
  } catch {
    return null;
  }
}

/** One row through the shipped direct path, with the stand-in transport in place of the network. */
async function directCode(row: Row): Promise<string | null> {
  answer = row.rejected === true ? 'reject' : { status: row.status, body: row.body };
  const response = await transcribeVoice(new Blob(['audio'], { type: 'audio/webm' }), 'clip.webm');
  return codeIn(response);
}

// ── driving the shipped adapters ─────────────────────────────────────────────────────────────

function audioRequest(): AsrRequest {
  return { audio: { bytes: new Uint8Array(8), mimeType: 'audio/webm;codecs=opus', fileName: 'clip.webm' } };
}

function invocationFor(row: Row): AsrInvocation {
  const fetchImpl: typeof fetch = async () => {
    if (row.rejected === true) {
      throw new TypeError('the transport never connected');
    }
    return new Response(row.body, { status: row.status, headers: { 'Content-Type': 'application/json' } });
  };
  // `.invalid` never resolves: this criterion must not be able to reach a real service by accident.
  return { baseUrl: 'https://asr.invalid', apiKey: 'test-key', model: 'test-model', timeoutMs: 1000, fetchImpl };
}

/** One row through one shipped adapter, at its `transcribe` seam with a stand-in transport. */
async function adapterCode(providerId: string, row: Row): Promise<string | null> {
  const result = await resolve(providerId).transcribe(audioRequest(), invocationFor(row));
  return result.ok ? null : result.code;
}

const ADAPTERS = ['openai-compatible', 'dashscope-omni'] as const;

/**
 * The two adapter modules, loaded by a specifier the module registry can re-resolve on demand.
 *
 * A static import would not do for the first falsifying form, and the reason is worth writing down:
 * a `vi.mock` factory's `importOriginal()` loads the ORIGINAL module graph, so the adapters that
 * graph pulls in are bound to the ORIGINAL registry — the mock reaches the test and the direct path
 * (both import the registry by the aliased specifier) but not the adapter objects the original
 * graph already built. Dropping the module registry and importing the adapter module again puts it
 * in the MOCKED graph, where its `../../asrRegistry.js` import resolves to the mock. Same shipped
 * source file, one dependency replaced — still an in-memory stand-in: no temporary file, no child
 * process, nothing left on disk.
 */
const FRESH_ADAPTERS: Record<string, () => Promise<AdapterModule>> = {
  'openai-compatible': () => import('@shared/asr/list/openai-compatible/openai-compatible.asr-provider'),
  'dashscope-omni': () => import('@shared/asr/list/dashscope-omni/dashscope-omni.asr-provider'),
};

type AdapterResult = { ok: true } | { ok: false; code: AsrErrorCode };
type AdapterModule = { transcribe: (request: AsrRequest, invocation: AsrInvocation) => Promise<AdapterResult> };

/** Every row through every adapter module, loaded fresh so the mock reaches them. */
async function freshAdapterCodes(): Promise<Record<string, Map<string, string | null>>> {
  vi.resetModules();
  const out: Record<string, Map<string, string | null>> = {};
  for (const providerId of Object.keys(FRESH_ADAPTERS)) {
    const load = FRESH_ADAPTERS[providerId];
    if (load === undefined) continue;
    const module_ = await load();
    const codes = new Map<string, string | null>();
    for (const row of FIXTURES) {
      const result = await module_.transcribe(audioRequest(), invocationFor(row));
      codes.set(label(row), result.ok ? null : result.code);
    }
    out[providerId] = codes;
  }
  return out;
}

// ── one full pass over the table ─────────────────────────────────────────────────────────────

type Reading = { row: Row; direct: string | null; adapters: Record<string, string | null> };

async function readTable(): Promise<Reading[]> {
  const readings: Reading[] = [];
  for (const row of FIXTURES) {
    const adapters: Record<string, string | null> = {};
    for (const providerId of ADAPTERS) {
      adapters[providerId] = await adapterCode(providerId, row);
    }
    readings.push({ row, direct: await directCode(row), adapters });
  }
  return readings;
}

function label(row: Row): string {
  return `${row.rejected === true ? 'transport-reject' : String(row.status)}|${row.code}`;
}

/** The distinct codes a status group produced, sorted — `AC3`'s reading unit. */
function groupOf(readings: Reading[], status: number): string[] {
  const codes = new Set<string>();
  for (const reading of readings) {
    if (reading.row.status === status && reading.row.rejected !== true) {
      codes.add(String(reading.direct));
    }
  }
  return [...codes].sort();
}

function directOf(readings: Reading[], code: string): string | null {
  return readings.find((reading) => reading.row.code === code)?.direct ?? null;
}

/** A fresh pass over the direct path only, for the second falsifying form. */
async function readDirectOnly(): Promise<Reading[]> {
  const readings: Reading[] = [];
  for (const row of FIXTURES) {
    readings.push({ row, direct: await directCode(row), adapters: {} });
  }
  return readings;
}

// ── the criterion ────────────────────────────────────────────────────────────────────────────

const STARTED_AT = Date.now();
const SELF_MODULE = fileURLToPath(import.meta.url);
const REPO_ROOT = join(SELF_MODULE, '..', '..', '..', '..');

/**
 * The specifiers that would let this criterion open a socket or start a process, assembled from
 * parts so this file's own scan cannot match its own text.
 */
function openDoors(): string[] {
  const specifiers = [
    `node:${'child'}_${'process'}`,
    `node:${'net'}`,
    `node:${'http'}`,
    `node:${'https'}`,
    `node:${'dgram'}`,
  ];
  const source = readFileSync(SELF_MODULE, 'utf8');
  return specifiers.filter((specifier) => source.includes(specifier));
}

/**
 * A recursive `path -> size` reading of the worktree, for the "no residue" half of `AC1`.
 *
 * `git status --porcelain` is the mechanism `AC1` names; this reads the same fact — nothing THIS run
 * could have written is changed — without a child process, because `AC1` also requires the criterion
 * to be subprocess-free and the two clauses cannot both hold literally. The entry keeps the path and
 * its SIZE, the content dimension `git status` compares: a path that appears, or whose size changes,
 * is residue; a path merely `touch`ed is not — so a concurrent writer that only bumps an mtime can
 * no longer red a reading that claims to report content.
 *
 * A path is skipped on ONE discipline — it belongs to some OTHER process that writes the worktree
 * while this criterion runs — and each class names its writer:
 *
 *   `.git`                        the repository's own metadata.
 *   `node_modules`                the shared install (a symlink to the main checkout).
 *   `dist`, `coverage`, `artifacts`, `.vite`   the build/test toolchain (vitest, vite).
 *   `test-results`, `playwright-report`        Playwright's own run outputs.
 *   `.playwright-mcp`             the Playwright MCP server appends its console/network logs for as
 *                                 long as a browser session is open; `.gitignore` names it (`:172`).
 *   `.quay`                       quay's runtime state: `.quay/anchor.json` is the driver's heartbeat
 *                                 and `.quay/per-file-cpu-*` its per-file accounts, rewritten every
 *                                 tick. `.gitignore` ignores `.quay/*`, re-including only the tracked
 *                                 `config.yml`/`profiles.yml`.
 *   `.workflow-events`, `orchestration`, `milestones`, `.quay-parse-cache.json`
 *                                 quay's tick ledgers and telemetry — the paths
 *                                 `plugin/scripts/quay-runtime-artifacts.txt` (the manifest
 *                                 `.gitignore:158` names) declares as quay's own runtime artifacts.
 *   `tasks`, `goals`              the driver's task and goal STORES. TRACKED by git, so
 *                                 `git status --porcelain` DOES see them — but the driver rewrites
 *                                 them mid-run, the one class a `git`-visible framing cannot exclude.
 *
 * `.gitignore` and `git status --porcelain` are the same fact seen from two sides: both are blind to
 * everything here except `tasks/` and `goals/`. That is why the reading cannot BE `git status` and
 * cannot be keyed on `mtime`. The `.gitignore`-derived tail keeps the class list from going stale as
 * the loop grows new runtime directories, while the named entries above state the classes that
 * `git check-ignore` / `git status` do NOT report.
 *
 * THE DERIVED TAIL HAS TWO HALVES. The whole-directory rules (`x/`, `x/*`, `x/**`) below skip a
 * TREE; the file-level rules (`*.log`, `*.pid`, the npm-debug family) cannot skip a tree without
 * hiding real source, so they are consulted per FILE in `isIgnoredFile`. Both are read from the same
 * `.gitignore`, because git's answer for `server.log` is the `.gitignore:46 *.log` line — and the
 * running server appends to that file for as long as it lives, so a reading that recorded it as
 * ordinary check state would red on a write THIS run never made (see `fileIgnoreRules`).
 */
function gitignoredTopLevelDirs(): string[] {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^\//, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    // Only whole-directory rules (`x/`, `x/*`, `x/**`) name a tree this walk can descend into; a
    // rule that ignores one file inside a real source directory must not hide that directory.
    const wholeDir = /^([^/*]+)\/$/.exec(line) ?? /^([^/*]+)\/\*\*?$/.exec(line);
    if (wholeDir?.[1] !== undefined) names.add(wholeDir[1]);
  }
  return [...names];
}

/**
 * The `.gitignore` FILE-level rules, in file order, translated to git's matching semantics.
 *
 * This is the half the whole-directory derivation above cannot see. A rule that names a file pattern
 * (`*.log`, `*.pid`, the npm-debug family) is not a tree this walk can skip, but git still refuses to
 * report a matching file — and `git status --porcelain` is exactly the fact `AC1` claims to read
 * (see the comment above). Without this list a live `server.log`, which the running server appends to
 * continuously, is recorded as an ordinary `path:size` entry and one append inside the run's one or
 * two seconds reds a criterion that says "nothing THIS run could have written is changed".
 *
 * Semantics, from the repository-root `.gitignore`:
 *   - a pattern with NO `/` matches a BASENAME at any depth (`*.log` hits `server.log` and
 *     `src/shared/tests/x.log`);
 *   - a pattern containing `/` is anchored at the repository root (`/artifacts/*`,
 *     `orchestration/inner-idle-log.jsonl`, and `.quay-parse-cache.json` when written with a leading
 *     double-star segment, which means "at any depth");
 *   - `*`, `?` and `**` are git's wildcards; a trailing `/` is DIRECTORY-only and never matches a
 *     file here;
 *   - `!` RE-INCLUDES and the LAST matching rule wins — which is what keeps
 *     `!scripts/__fixtures__/*.log` (a committed fixture) OUT of the skip set even though `*.log`
 *     matched it first. That negation is load-bearing in the other direction too: a fixture log is
 *     residue if the run writes it.
 *
 * ⛔ File rules are never applied to DIRECTORIES (`treeSnapshot` consults this list only on a file):
 * a `*.log` rule must not hide `src/shared/tests/` merely because a probe log was written there.
 */
type IgnoreRule = { readonly pattern: RegExp; readonly negated: boolean };

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        // `**/` spans zero or more path segments; a trailing `**` spans everything below.
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function fileIgnoreRules(): IgnoreRule[] {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const negated = trimmed.startsWith('!');
    const pattern = (negated ? trimmed.slice(1) : trimmed).replace(/^\//, '');
    if (pattern === '' || pattern.endsWith('/')) continue; // directory-only rule
    rules.push({ pattern: globToRegExp(pattern), negated });
  }
  return rules;
}

const FILE_IGNORE_RULES = fileIgnoreRules();

/** Whether git would ignore this repository-relative FILE path, read off the ordered rule list. */
function isIgnoredFile(relativePath: string): boolean {
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  let ignored = false;
  for (const rule of FILE_IGNORE_RULES) {
    // A root-anchored pattern cannot match a basename (it contains `/`); a basename pattern matches
    // at any depth, so testing both readings applies each rule exactly where git would.
    if (rule.pattern.test(relativePath) || rule.pattern.test(basename)) ignored = !rule.negated;
  }
  return ignored;
}

function treeSnapshot(): string[] {
  const skip = new Set([
    '.git', 'node_modules', 'dist', 'coverage', 'artifacts', '.vite',
    'test-results', 'playwright-report',
    '.playwright-mcp', '.quay', '.workflow-events', 'orchestration', 'milestones',
    '.quay-parse-cache.json',
    'tasks', 'goals',
    ...gitignoredTopLevelDirs(),
  ]);
  const entries: string[] = [];
  const walk = (dir: string): void => {
    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      return;
    }
    for (const child of children.sort()) {
      if (skip.has(child)) continue;
      const path = join(dir, child);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        const relativePath = path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
        if (isIgnoredFile(relativePath)) continue;
        entries.push(`${path.replace(REPO_ROOT, '')}:${stat.size}`);
      }
    }
  };
  walk(REPO_ROOT);
  return entries;
}

const SNAPSHOT_AT_START = treeSnapshot();

let cachedBase: Reading[] | null = null;

async function base(): Promise<Reading[]> {
  if (cachedBase === null) {
    await armDirectPath();
    cachedBase = await readTable();
  }
  return cachedBase;
}

test('AC1/AC2: one fixture table, three shipped seams, one code per row', async () => {
  const readings = await base();

  for (const reading of readings) {
    process.stdout.write(
      `row=${label(reading.row)} expected=${reading.row.expected}` +
        ` direct=${reading.direct} adapter=${reading.adapters['openai-compatible']}\n`,
    );
  }

  const rows = readings.length;
  const openaiFamily = readings.filter((reading) => OPENAI_FAMILY.includes(reading.row.code)).length;
  const agreed = readings.filter(
    (reading) =>
      reading.direct === reading.row.expected &&
      ADAPTERS.every((providerId) => reading.adapters[providerId] === reading.row.expected),
  ).length;
  const fallback = directOf(readings, UNKNOWN_CODE_ROW);

  process.stdout.write(
    `rows=${rows} openai-family=${openaiFamily} agreed=${agreed} unknown-code-fallback=${fallback}\n`,
  );

  expect(openaiFamily, 'the OpenAI-compatible spelling family must be in the table').toBeGreaterThanOrEqual(4);
  expect(agreed, 'every row must read one code on the direct path and on both shipped adapters').toBe(rows);
  expect(fallback, 'a code string the table does not know must fall back to the status').toBe('UNAUTHORIZED');

  // The table is driven through the SHIPPED direct branch, not through the proxy hop.
  expect(
    requested.some((url) => url.startsWith(BACKEND_ORIGIN)),
    'no request reached the user backend: the direct branch was never taken',
  ).toBe(true);
  expect(requested.filter((url) => url === CONFIG_URL).length, 'the settings are read once').toBe(1);
});

test('AC3: same status, different code — and the controls that must NOT differ', async () => {
  const readings = await base();

  const groups = GROUP_STATUSES.map((status) => ({ status, codes: groupOf(readings, status) }));
  const [g400, g429, g404] = groups;
  const forbidden = readings.find((reading) => reading.row.status === 403 && reading.row.body.includes('forbidden'));

  process.stdout.write(
    `${groups.map((group) => `status=${group.status} codes=${group.codes.join(',')}`).join(' ')}` +
      ` distinct400=${g400.codes.length} distinct429=${g429.codes.length} distinct404=${g404.codes.length}` +
      ` same-code-control=401:${directOf(readings, 'InvalidApiKey')}=${directOf(readings, 'invalid_api_key')}` +
      ` 403:${forbidden?.direct ?? '(none)'}=${directOf(readings, UNKNOWN_CODE_ROW)}\n`,
  );

  expect(g400.codes.length, 'the 400 group must not collapse to one code').toBeGreaterThanOrEqual(2);
  expect(directOf(readings, 'Arrearage')).not.toBe(directOf(readings, 'DataInspectionFailed'));

  expect(g429.codes.length, 'the 429 group must hold exactly the two facts').toBe(2);
  expect(g429.codes).toContain('QUOTA_EXHAUSTED');
  expect(g429.codes).toContain('RATE_LIMITED');

  expect(g404.codes.length, 'the 404 group must hold the named code and the fallback').toBe(2);
  expect(g404.codes).toContain('MODEL_NOT_FOUND');
  expect(g404.codes).toContain('UPSTREAM_UNAVAILABLE');

  // The positive control: "differ" must not be an assertion over an empty set. These pairs share a
  // status AND a code, and are exactly what a status-only reading would have collapsed.
  expect(directOf(readings, 'InvalidApiKey'), '401 pair: two spellings, one code').toBe('UNAUTHORIZED');
  expect(directOf(readings, 'invalid_api_key'), '401 pair: two spellings, one code').toBe('UNAUTHORIZED');
  expect(forbidden?.direct, '403 pair: a body naming nothing lands on the status').toBe('UNAUTHORIZED');
  expect(directOf(readings, UNKNOWN_CODE_ROW), '403 pair: an unknown code string lands on the status').toBe('UNAUTHORIZED');
  for (const control of SAME_CODE_CONTROLS) {
    expect(directOf(readings, control), `the control '${control}' is a row of the table`).not.toBeNull();
  }
});

test('AC4: one definition point, and the client reads it from there', () => {
  const paths = [
    'shared/asr/asrRegistry.ts',
    'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts',
    'shared/asr/list/multimodal/multimodal.asr-provider.ts',
    'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
    'src/shared/api.ts',
  ];
  const sources = new Map(paths.map((path) => [path, readFileSync(join(REPO_ROOT, path), 'utf8')]));

  // Only DEFINITION POINTS and IMPORT STATEMENTS are read here. A per-line text search would count
  // the three adapters' own comments, which explain the table they no longer hold by naming it — a
  // trap this repository has met before. The load-bearing evidence for this reading is the
  // executable first falsifying form below, not this scan.
  const count = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length;
  const classifierDef = /^export\s+function\s+classifyUpstreamFailure\s*\(/m;
  const tableDef = /^\s*const\s+UPSTREAM_CODE_RULES\b/m;
  const localTable = /^\s*(?:export\s+)?function\s+errorCodeForStatus\s*\(/m;
  const clientLocalTable =
    /^\s*(?:const|function)\s+\w*(?:CODE_RULES|CODE_TABLE|codeForStatus|errorCodeForStatus|classifyUpstreamFailure)\b/m;
  const clientSharedImport = /import\s*\{[^}]*\bclassifyUpstreamFailure\b[^}]*\}\s*from\s*'@shared\/asr\/[^']+'/;

  const registry = sources.get('shared/asr/asrRegistry.ts') ?? '';
  const api = sources.get('src/shared/api.ts') ?? '';
  const classifiers = [...sources.values()].reduce((total, source) => total + count(source, classifierDef), 0);
  const tables = [...sources.values()].reduce((total, source) => total + count(source, tableDef), 0);
  const adapterTables = [
    'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts',
    'shared/asr/list/multimodal/multimodal.asr-provider.ts',
    'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
  ].reduce((total, path) => total + count(sources.get(path) ?? '', localTable), 0);
  const clientTables = count(api, clientLocalTable);
  const clientImportsShared = clientSharedImport.test(api);

  process.stdout.write(
    `classifier-defs=${classifiers} table-defs=${tables} adapter-local-tables=${adapterTables}` +
      ` client-local-tables=${clientTables} client-imports-shared=${clientImportsShared}\n`,
  );

  expect(classifiers, 'the classifier is defined at exactly one point').toBe(1);
  expect(count(registry, classifierDef), 'and that point is in the shared recognition directory').toBe(1);
  expect(tables, 'the code-string table is defined at exactly one point').toBe(1);
  expect(adapterTables, 'no adapter keeps a status-to-code table of its own').toBe(0);
  expect(clientTables, 'the client keeps no table of its own').toBe(0);
  expect(clientImportsShared, 'the client reaches the classifier as a VALUE import from @shared/asr/...').toBe(true);
});

test('AC5 (i) client-second-table: both paths follow the shared classifier and nothing else', async () => {
  const before = await base();
  const baseGreen = before.every(
    (reading) => reading.direct === reading.row.expected && reading.adapters['openai-compatible'] === reading.row.expected,
  );

  // The lever: the SHARED classifier answers a constant. A client (or an adapter) carrying a table
  // of its own would not move; one that reads the shared implementation has no choice but to move.
  lever.classify = () => 'UPSTREAM_UNAVAILABLE';
  const afterDirect = await readDirectOnly();
  const afterAdapters = await freshAdapterCodes();
  lever.classify = null;

  // The predicted family: every row the shared classifier carries whose expected code is not
  // already the mutant's answer — an unconditional mutant cannot be told apart on a row whose
  // expected code IS what it answers. The envelope row is outside it because `NO_SPEECH_DETECTED`
  // is not in the classifier's range at all (`AC-149`'s own criterion pins a `2xx` to
  // `UPSTREAM_UNAVAILABLE`), so no mutation of the classifier can move it.
  const family = before.filter(
    (reading) => reading.row.family === 'classifier' && reading.row.expected !== 'UPSTREAM_UNAVAILABLE',
  );
  const directByLabel = new Map(afterDirect.map((reading) => [label(reading.row), reading.direct]));
  const followed = family.filter((reading) => directByLabel.get(label(reading.row)) === 'UPSTREAM_UNAVAILABLE');
  const adapterFollowed = family.filter((reading) =>
    ADAPTERS.every(
      (providerId) => afterAdapters[providerId]?.get(label(reading.row)) === 'UPSTREAM_UNAVAILABLE',
    ),
  );
  const reds = family.filter((reading) => directByLabel.get(label(reading.row)) !== reading.direct);
  const outside = before.filter((reading) => !family.includes(reading));
  const outsideGreen = outside.every(
    (reading) => directByLabel.get(label(reading.row)) === reading.row.expected,
  );

  process.stdout.write(
    `mutation=client-second-table base-green=${baseGreen} mutant-red=${reds.length > 0}` +
      ` which=${reds[0] === undefined ? '(none)' : label(reds[0].row)} outside-family-green=${outsideGreen}\n`,
  );
  process.stdout.write(
    `reading client-second-table = direct-family=${family.length} direct-followed-shared=${followed.length}` +
      ` adapter-followed-shared=${adapterFollowed.length} outside=${outside.length} outside-green=${outsideGreen}\n`,
  );

  expect(baseGreen, 'the unmutated copy is green before the mutant is applied').toBe(true);
  expect(followed.length, 'every row the shared classifier carries must follow it on the direct path').toBe(
    family.length,
  );
  expect(adapterFollowed.length, 'and both shipped adapters must follow the same lever').toBe(family.length);
  expect(reds.length, 'so the predicted family is exactly what the mutant reddened').toBe(family.length);
  expect(family.length, 'the family is not empty: the mutant was applied to rows it could move').toBeGreaterThan(0);
  expect(outsideGreen, 'the rows the classifier does not carry keep their expected code').toBe(true);
});

test('AC5 (ii) direct-status-only: a status-only classification cannot tell one status apart', async () => {
  const before = await base();
  const beforeGroups = GROUP_STATUSES.map((status) => groupOf(before, status).length);

  // The lever: the shared classifier answers from the status alone (`errorCodeForStatus`'s rule),
  // AND every body-reading input of the direct path's classification is blinded — the wire is made
  // to see text in every answer. `AC-149`'s classifier answers `UPSTREAM_UNAVAILABLE` for a `2xx`
  // whether or not it reads the body, so a `2xx` row cannot be moved by the classifier lever alone;
  // blinding the wire is what puts the run in the state "this path reads only the status".
  const statusOnly = (status: number | undefined): AsrErrorCode => {
    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status === 429) return 'RATE_LIMITED';
    return 'UPSTREAM_UNAVAILABLE';
  };
  lever.classify = (status) => statusOnly(status);
  lever.parse = async () => 'spoken words';
  const after = await readDirectOnly();
  lever.classify = null;
  lever.parse = null;

  const afterGroups = GROUP_STATUSES.map((status) => groupOf(after, status).length);
  const controlsGreen =
    directOf(after, 'InvalidApiKey') === 'UNAUTHORIZED' &&
    directOf(after, 'invalid_api_key') === 'UNAUTHORIZED' &&
    directOf(after, UNKNOWN_CODE_ROW) === 'UNAUTHORIZED';
  const envelopeIndex = before.findIndex((reading) => reading.row.family === 'envelope');
  const envelopeRed =
    before[envelopeIndex] !== undefined &&
    after[envelopeIndex] !== undefined &&
    after[envelopeIndex].direct !== before[envelopeIndex].direct;

  // The predicted family: every row whose code is read off a code STRING (a body that names one —
  // those are the rows a status-only reading loses), plus the envelope row, whose silence only a
  // body reading can find. The rows left outside name nothing, so the status alone gets them right
  // and the mutant cannot move them: they are this form's control.
  const family = before.filter(
    (reading) =>
      reading.row.family === 'envelope' || (reading.row.rejected !== true && reading.row.code !== '(none)'),
  );
  const changed = before.filter(
    (reading, index) => after[index] !== undefined && after[index].direct !== reading.direct,
  );
  const outside = before.filter((reading) => !family.includes(reading));
  const outsideGreen = outside.every((reading) => {
    const index = before.indexOf(reading);
    return after[index] !== undefined && after[index].direct === reading.row.expected;
  });
  const strays = changed.filter((reading) => !family.includes(reading));

  process.stdout.write(
    `mutation=direct-status-only base-green=${beforeGroups.join('/')} mutant-red=${changed.length > 0}` +
      ` which=${changed[0] === undefined ? '(none)' : label(changed[0].row)} outside-family-green=${outsideGreen}\n`,
  );
  process.stdout.write(
    `reading direct-status-only = groups-before=${beforeGroups.join('/')} groups-after=${afterGroups.join('/')}` +
      ` envelope-row-red=${envelopeRed} controls-green=${controlsGreen} strays=${strays.length}` +
      ` distinct400=${afterGroups[0]} distinct429=${afterGroups[1]} distinct404=${afterGroups[2]}\n`,
  );

  expect(beforeGroups, 'the unmutated copy separates all three groups').toEqual([3, 2, 2]);
  expect(afterGroups[0], 'a status-only reading collapses the 400 group').toBeLessThan(beforeGroups[0] ?? 0);
  expect(afterGroups[1], 'a status-only reading collapses the 429 group').toBeLessThan(beforeGroups[1] ?? 0);
  expect(afterGroups[2], 'a status-only reading collapses the 404 group').toBeLessThan(beforeGroups[2] ?? 0);
  expect(envelopeRed, 'and a silent 200 can no longer be told from a transcript').toBe(true);
  expect(controlsGreen, 'while rows that share a status AND a code stay green').toBe(true);
  expect(outsideGreen, 'and so does every row the status alone gets right').toBe(true);
  expect(strays.length, 'no row outside the predicted family moved').toBe(0);
  expect(changed.length, 'the mutant reddened rows — it is not a no-op').toBeGreaterThan(0);
});

test('AC1: budget, doors, and no residue', () => {
  const elapsed = Date.now() - STARTED_AT;
  const doors = openDoors();
  const residue = treeSnapshot().filter((entry) => !SNAPSHOT_AT_START.includes(entry));
  const shipped = tryResolve(listProviders()[0]?.id ?? '');

  process.stdout.write(`elapsed-ms=${elapsed}\n`);
  process.stdout.write(
    `reading AC1 scope = elapsed-ms=${elapsed} subprocess-imports=${doors.length} [${doors.join(' ')}]` +
      ` git-clean-after=${residue.length === 0} offline-transport=injected ports=0 shipped=${shipped !== null}\n`,
  );

  expect(doors, `this criterion imports a module that can open a socket or start a process: ${doors.join(', ')}`).toEqual([]);
  expect(residue, `the run left files behind: ${residue.slice(0, 5).join(', ')}`).toEqual([]);
  expect(elapsed, `the criterion took ${elapsed}ms, past its own 30s budget`).toBeLessThan(30_000);
  expect(shipped, 'the shipped provider the direct path was aimed at is a registered one').not.toBeNull();
});
