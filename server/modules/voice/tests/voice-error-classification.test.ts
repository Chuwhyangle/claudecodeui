/**
 * AC-149's criterion: an upstream failure is classified by the error CODE its answer carries, with the
 * status as the fallback, into the stable vocabulary — and the code→HTTP table has exactly one row per
 * member, no more and no fewer.
 *
 * WHAT IS BEING READ, AND WHY IT NEEDS A READING AT ALL. Each adapter used to own a three-line
 * `errorCodeForStatus(status)`: `401|403 → UNAUTHORIZED`, `429 → RATE_LIMITED`, everything else
 * `UPSTREAM_ERROR`. A mapper that reads only the number cannot tell apart three different facts a
 * `403` carries — a refused credential, a model the account has not enabled, an account in arrears —
 * and the sentence the user needs differs for each. So the reading here is not "a status maps to a
 * code" (that was already true); it is "the ANSWER BODY decides, the status is the fallback, and one
 * (status, body) pair reads the same way through the pure classifier and through the shipped
 * adapter". Two rows below share a status and differ in their code string, which is the reading that
 * separates body-first from status-only.
 *
 * HOW THE READINGS ARE TAKEN. Nothing here reaches a network, a socket or a process. The pure
 * classifier is called directly; the shipped `dashscope-omni` adapter is driven through an OFFLINE
 * STAND-IN TRANSPORT injected on `AsrInvocation.fetchImpl`, which answers with the very body the row
 * names — so the code the adapter reports is a reading of those bytes and not of the process around
 * it. The status table is read twice and the two readings are required to agree: as the runtime object
 * imported from `voice.service.ts`, and as the source text that object is written as. The second
 * reading is what a falsifying form can move (see
 * `voice-error-classification.false-forms.test.ts`).
 *
 * THE IMPORT SHAPE IS LOAD-BEARING. The adapter value-imports `baseMimeType`/`declaredAcceptsMime`/
 * `classifyUpstreamFailure` from `shared/asr/contract/asrContract.ts` (re-exported by the registry),
 * so the registry and its adapters no longer form a value-edge cycle — the first split removed the
 * file-level one, and the contract now sits in its own leaf directory so ArchGuard's directory
 * granularity sees the same one-way edge. The contract is still imported before the adapter, so the
 * shared instance is fully evaluated before any mutated copy is opened, and the adapter is entered
 * with `await import(...)` — the shape
 * `voice-provider-dispatch.test.ts` records.
 *
 * WHAT THIS FILE DOES NOT DO, AND WHERE THAT HALF LIVES. AC7 asks for the exit code of a list of
 * existing criteria plus `npm run typecheck` and `npm run lint`; AC8's drift evidence is a compiler
 * run. Those are SUBPROCESSES, and AC1 requires this file to start none within a 15-second budget —
 * one `npm run typecheck` alone measures ~11 s here. Both halves live in
 * `voice-error-classification.false-forms.test.ts`, this task's other executable artifact and the file
 * AC1's budget is not about; both files' headers say which half they carry, and AC8's reading below
 * says out loud which part of it is not measured here.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ASR_ERROR_CODES, classifyUpstreamFailure } from '../../../../shared/asr/asrRegistry.js';
import type {
  AsrAdapter,
  AsrErrorCode,
  AsrInvocation,
  AsrRequest,
} from '../../../../shared/asr/asrRegistry.js';
import { PROVIDER_ERROR_STATUS } from '../voice.service.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — three levels above this file (`server/modules/voice/tests/`). */
const SERVER_DIR = path.resolve(HERE, '../../..');
/** The repository root, one level above `server/`. */
const REPO_ROOT = path.resolve(SERVER_DIR, '..');

/** The contract: the one home of the vocabulary and of the classifier (re-exported by the registry). */
export const SHIPPING_CONTRACT_MODULE = path.join(REPO_ROOT, 'shared/asr/contract/asrContract.ts');
/** The shipped service: the one home of the code→HTTP table. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');

/** The shipped adapter every row is driven through, and the other two read by AC5's table scan. */
const DASHSCOPE_MODULE = path.join(
  REPO_ROOT,
  'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
);
const ADAPTER_MODULES: readonly string[] = [
  DASHSCOPE_MODULE,
  path.join(REPO_ROOT, 'shared/asr/list/multimodal/multimodal.asr-provider.ts'),
  path.join(REPO_ROOT, 'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts'),
];

/** This file, read as text by the door scan. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading must be a red, not a shorter green list. */
const READINGS_EXPECTED = 6;

/**
 * THE CONTRACT, ENTERED FIRST AND ON PURPOSE. This task split the contract out of the registry and
 * removed the registry↔adapter value cycle, so the old temporal-dead-zone hazard is gone; the
 * shipping contract is still imported here by PATH before any mutated copy is opened, so an arm
 * that points the override at a copy measures the copy and never re-initialises the shared one.
 * Importing it here by PATH resolves to the same file URL the adapters' relative specifier does.
 */
const CONTRACT_MODULE_URL = pathToFileURL(SHIPPING_CONTRACT_MODULE).href;

/** A module specifier, assembled rather than spelled — see `FORBIDDEN_SPECIFIERS`. */
const specifier = (parts: readonly string[]): string => `'${parts.join('')}'`;

/**
 * The doors a criterion in this family closes: a child process, a listening socket, an outbound
 * request, a thread. A candidate is assembled from parts so that the scan's own text cannot be the
 * thing it matches — spelled out, every candidate would appear in this file whether or not this file
 * imported it, and the scan would report the criterion itself.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  specifier(['node:', 'child', '_process']),
  specifier(['node:', 'net']),
  specifier(['node:', 'http']),
  specifier(['node:', 'https']),
  specifier(['node:', 'dgram']),
  specifier(['node:', 'cluster']),
  specifier(['node:', 'tls']),
  specifier(['node:', 'worker', '_threads']),
  specifier(['expr', 'ess']),
  specifier(['mult', 'er']),
];

/** The doors THIS file has open, computed from its own text. */
function openDoors(): string[] {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return FORBIDDEN_SPECIFIERS.filter((candidate) => source.includes(candidate));
}

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────

/**
 * One (status, answer body) pair and the code it must be classified as.
 *
 * `code` is the error code string as the answer carries it, and it is what the printed row line names
 * — `(none)` for an answer that carries no code at all, which is the half of the criterion that says
 * the status is the FALLBACK rather than the rule; `(transport-refused)`/`(deadline-aborted)` for a
 * row where no answer arrived to carry a code.
 */
type FixtureRow = {
  code: string;
  status?: number;
  body: string;
  expected: AsrErrorCode;
  /** How the stand-in transport produces this row: an answer, a refused connection, a deadline. */
  drive: 'response' | 'reject' | 'abort';
  /**
   * Which arm can decide this row.
   *
   *   · `'pure'` — an upstream FAILURE, so `classifyUpstreamFailure` decides it and the shipped
   *     adapter must agree with it. Two rows sharing a status and differing in their code string are
   *     what makes "the body wins" a reading rather than a description.
   *   · `'adapter'` — a `200`, which is not an upstream failure at all. The classifier has no answer
   *     for a successful answer (its fallback would guess `UPSTREAM_UNAVAILABLE`), so such a row is
   *     carried by the adapter's own ENVELOPE reading, the only thing that can produce
   *     `NO_SPEECH_DETECTED` from a well-formed answer that says nothing.
   */
  via: 'pure' | 'adapter';
};

/** An answer body that names `code` in the `error.code` field — the spelling this family uses. */
function names(code: string, message?: string): string {
  return JSON.stringify({ error: { code, ...(message === undefined ? {} : { message }) } });
}

/** A `200`-shaped chat envelope, as this service's own wire reads it. */
function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

/**
 * The classes AC-149 names, one row each, plus the rows that keep the fallback honest.
 *
 * THE ROWS THAT SHARE A STATUS ARE THE SUBJECT. `400` carries `Arrearage` (an account in arrears),
 * `InvalidParameter` over the recording's duration, `DataInspectionFailed` (content moderation) and an
 * unknown code; `429` carries two different quota codes and one rate-limit code. A mapper that read
 * only the status would answer one code for all four of the first group and one for all three of the
 * second — which is exactly the mutation case `status-only` in the falsifying file, and why AC3 reads
 * the code SET of each group rather than a row at a time.
 *
 * THE UNKNOWN-CODE ROWS ARE THE OTHER HALF: a code the table does not know is not guessed at by a
 * looser pattern, it falls to the status fallback — `UNAUTHORIZED` at a `403`, `UPSTREAM_UNAVAILABLE`
 * at a `400`. That is what keeps the table's silence about a code an honest answer instead of a
 * classification.
 *
 * THE TWO `200` ROWS ARE CARRIED BY THE ADAPTER. `{}` parses as an answer that says nothing (both
 * fields empty ⇒ `NO_SPEECH_DETECTED`, and NOT `UPSTREAM_UNAVAILABLE`, which is the pair the
 * module's own comment calls out); `{"ok":true}` is not this service's envelope at all ⇒
 * `UPSTREAM_UNAVAILABLE`, and NOT `NO_SPEECH_DETECTED`.
 */
const FIXTURES: readonly FixtureRow[] = [
  {
    code: 'AccessDenied.Unpurchased',
    status: 403,
    body: names('AccessDenied.Unpurchased', 'the model is not purchased'),
    expected: 'ACCOUNT_ACCESS',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'Arrearage',
    status: 400,
    body: names('Arrearage', 'the account is in arrears'),
    expected: 'ACCOUNT_ACCESS',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'InvalidApiKey',
    status: 401,
    body: names('InvalidApiKey', 'invalid api key'),
    expected: 'UNAUTHORIZED',
    drive: 'response',
    via: 'pure',
  },
  {
    // The positive control for the row above: a `403` whose body names NO code is the refused
    // credential, and it must read the same code as the `401` that names one — so "the body decides"
    // cannot be satisfied by a classifier that simply answered differently for every body.
    code: '(none)',
    status: 403,
    body: JSON.stringify({ error: { message: 'forbidden' } }),
    expected: 'UNAUTHORIZED',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'AllocationQuota.FreeTierOnly',
    status: 429,
    body: JSON.stringify({ code: 'AllocationQuota.FreeTierOnly', message: 'free tier exhausted' }),
    expected: 'QUOTA_EXHAUSTED',
    drive: 'response',
    via: 'pure',
  },
  {
    // The longer sibling of the row above, in the `Throttling.` family: whichever way the table orders
    // its rules, this code must not be taken by a wider `Throttling.` or `Allocation` rule.
    code: 'Throttling.AllocationQuota',
    status: 429,
    body: names('Throttling.AllocationQuota', 'quota exhausted'),
    expected: 'QUOTA_EXHAUSTED',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'Throttling.RateQuota',
    status: 429,
    body: names('Throttling.RateQuota', 'slow down'),
    expected: 'RATE_LIMITED',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'ModelNotFound',
    status: 404,
    body: names('ModelNotFound', 'no such model'),
    expected: 'MODEL_NOT_FOUND',
    drive: 'response',
    via: 'pure',
  },
  {
    // `InvalidParameter` is the service's generic "this request was malformed"; it is the recording's
    // duration only when the body says so, which is why this row's body carries the wording and the
    // row below it would not be enough on its own.
    code: 'InvalidParameter',
    status: 400,
    body: names('InvalidParameter', 'audio duration must be 1 to 300 seconds'),
    expected: 'AUDIO_REJECTED',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'DataInspectionFailed',
    status: 400,
    body: names('DataInspectionFailed', 'the audio was rejected by content moderation'),
    expected: 'CONTENT_FLAGGED',
    drive: 'response',
    via: 'pure',
  },
  {
    code: '(none)',
    status: 500,
    body: 'the upstream fell over',
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'response',
    via: 'pure',
  },
  {
    code: '(none)',
    status: 503,
    body: 'service unavailable',
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'response',
    via: 'pure',
  },
  {
    code: '(none)',
    status: 408,
    body: 'request timeout',
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'response',
    via: 'pure',
  },
  {
    // The transport refused: there is no status AND no body, and the code is the one the 5xx rows
    // read — ONE member for the three transport failures (5xx, refused, deadline).
    code: '(transport-refused)',
    body: '',
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'reject',
    via: 'pure',
  },
  {
    code: '(deadline-aborted)',
    body: '',
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'abort',
    via: 'pure',
  },
  {
    code: '(no-instruction-no-transcript)',
    status: 200,
    body: envelope('{}'),
    expected: 'NO_SPEECH_DETECTED',
    drive: 'response',
    via: 'adapter',
  },
  {
    code: 'SomethingElse.New',
    status: 403,
    body: names('SomethingElse.New', 'something this table has never seen'),
    expected: 'UNAUTHORIZED',
    drive: 'response',
    via: 'pure',
  },
  {
    code: 'SomethingElse.New',
    status: 400,
    body: names('SomethingElse.New', 'something this table has never seen'),
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'response',
    via: 'pure',
  },
  {
    code: '(not-an-envelope)',
    status: 200,
    body: JSON.stringify({ ok: true }),
    expected: 'UPSTREAM_UNAVAILABLE',
    drive: 'response',
    via: 'adapter',
  },
];

/** `row=<status>|<code>` — the label every row line opens with. */
function rowLabel(row: FixtureRow): string {
  return `${row.status === undefined ? '(none)' : row.status}|${row.code}`;
}

/**
 * The index of a fixture row, looked up by the pair that identifies it rather than by position: a row
 * inserted or removed above must not silently re-point a reading at a different row. A lookup that
 * finds nothing returns `-1`, and the reading that used it goes red because `pure[-1]` is `undefined`
 * — a miss is a red, never a skip.
 */
function rowIndex(status: number | undefined, code: string): number {
  return FIXTURES.findIndex((row) => row.status === status && row.code === code);
}

/** The codes one index list answers, sorted and de-duplicated. */
function codesOf(measurement: Measurement, indexes: readonly number[]): string[] {
  return [...new Set(indexes.map((index) => measurement.pure[index]))].sort();
}

/** The indexes of every fixture row whose status is `status`. */
function indexesWithStatus(status: number): number[] {
  return FIXTURES.map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.status === status)
    .map((entry) => entry.index);
}

// ── the table, read as the text it is written as ──────────────────────────────────────────────

/**
 * The rows of `PROVIDER_ERROR_STATUS`, parsed out of the source text of `voice.service.ts`.
 *
 * WHY THE TABLE IS READ AS TEXT AT ALL, given that it is also imported. `Readonly<Record<AsrErrorCode,
 * number>>` makes a MISSING row a compile error and does not make an EXTRA row one, so "exactly one
 * row per member" is a reading the compiler cannot take; and the falsifying forms that must move it
 * are a row deleted and a row added, both of which are TYPE errors in a module the project's
 * typecheck compiles. A mutant copy of the table is therefore a copy of its SOURCE TEXT, which
 * compiles nowhere and is checked by nothing — see the falsifying file's header. Reading the shipping
 * table the same way the mutant is read is what makes the two arms one experiment; the runtime import
 * is required to agree with the parsed rows, so a parser that drifted from the object it parses is a
 * red rather than a quietly different reading.
 *
 * Fail-closed on absence: no declaration, no braces, or no rows yields an empty list, which reds the
 * key-set equality instead of passing a loop over nothing.
 */
export function tableRowsFromSource(text: string): { code: string; status: number }[] {
  const start = text.indexOf('export const PROVIDER_ERROR_STATUS');
  if (start === -1) return [];
  const open = text.indexOf('{', start);
  const close = text.indexOf('\n};', open);
  if (open === -1 || close === -1) return [];
  const rows: { code: string; status: number }[] = [];
  const row = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\d+)\s*,\s*$/;
  for (const line of text.slice(open + 1, close).split('\n')) {
    const match = row.exec(line);
    if (match !== null) rows.push({ code: match[1], status: Number(match[2]) });
  }
  return rows;
}

/**
 * The lines of a source file that are CODE, with whole-line comments dropped.
 *
 * THIS EXISTS BECAUSE THE PROSE NAMES THE THING IT REPLACED. Each adapter's header still says, in
 * backticks, that a three-line `errorCodeForStatus` used to live there and why it was the defect — so
 * a scan that read the raw file would find the deleted function's name in the sentence explaining its
 * deletion and report a table that is not there. Dropping whole-line comments (`*` continuation, `//`,
 * `/*`) is enough for that: the mentions are all in block comments. A trailing comment on a code line
 * survives the filter on purpose — the code on such a line is what the scan is about.
 */
export function codeLinesOf(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
}

/** The vocabulary members a status table would name as values. */
const CODE_LITERAL =
  /'(ACCOUNT_ACCESS|UNAUTHORIZED|QUOTA_EXHAUSTED|RATE_LIMITED|MODEL_NOT_FOUND|AUDIO_REJECTED|CONTENT_FLAGGED)'/;

/**
 * Whether an adapter still keeps a code table of its own.
 *
 * TWO SHAPES, BOTH MECHANICAL. The deleted mapper's NAME is the first: a DECLARATION of
 * `errorCodeForStatus` in an adapter is precisely the per-adapter table this task removed, and the
 * check is for a declaration (`function`/`const`/`let`/`var`) rather than for the bare word so that
 * the comment recording the deletion is not read as the deletion failing to happen. The second shape
 * is what a re-implementation would take instead — a status COMPARISON on the same line as a
 * vocabulary literal, which is what `if (status === 401 || status === 403) return 'UNAUTHORIZED';`
 * is. A line that merely READS a status (to build a message, or to hand the number to the classifier)
 * carries no code literal, so the message branches these adapters legitimately keep are not mistaken
 * for a table.
 */
export function carriesOwnCodeTable(source: string): boolean {
  const lines = codeLinesOf(source);
  if (lines.some((line) => /\b(?:function|const|let|var)\s+errorCodeForStatus\b/.test(line))) return true;
  return lines.some((line) => /\bstatus\b/.test(line) && CODE_LITERAL.test(line));
}

/** The static-alignment declaration AC8 reads, as the line that has to be there. */
const ALIGNMENT_DECLARATION = 'export const ASR_ERROR_CODE_ALIGNMENT';

// ── the measurement ───────────────────────────────────────────────────────────────────────────

export type CriterionOverrides = {
  /**
   * A contract module to take the vocabulary and the classifier from, instead of the shipping one. A
   * falsifying form points this at a text-mutated copy; the shipping run leaves it unset.
   */
  contract?: string;
  /**
   * The path whose TEXT the status table's rows are parsed from. The runtime import is always the
   * shipping `PROVIDER_ERROR_STATUS`, and the two are required to agree — so a falsifying form that
   * deletes or adds a row in a copy of the source moves the parsed reading and reds that agreement,
   * which is the point of reading the table as text at all.
   */
  serviceSource?: string;
};

export type ReadingOutcome = { name: string; value: string; ok: boolean };

type ContractModule = {
  ASR_ERROR_CODES: readonly AsrErrorCode[];
  ASR_ERROR_CODE_ALIGNMENT: Readonly<Record<string, true>>;
  classifyUpstreamFailure: (status: number | undefined, body: string) => AsrErrorCode;
};

type AdapterModule = { id: string; transcribe: AsrAdapter['transcribe'] };

type Measurement = {
  /** The vocabulary, from the contract under test. */
  vocab: readonly AsrErrorCode[];
  /** The contract under test's own source text, read by AC8. */
  contractSource: string;
  /** The table as the runtime object, which is always the shipping one. */
  tableRuntime: Readonly<Record<string, number>>;
  /** The table as the source text says it is written. */
  tableSourceRows: { code: string; status: number }[];
  /** Per fixture index: what the pure classifier answered, or `(not-classifiable)`. */
  pure: string[];
  /** Per fixture index: what the shipped adapter answered through the stand-in transport. */
  adapter: string[];
  /** The driven adapter's own registry id — what it calls itself, not the path it sits at. */
  adapterId: string;
  /** Per adapter: its own text, whether it still keeps a table, and whether it delegates. */
  adapterSources: { path: string; ownTable: boolean; delegates: boolean }[];
};

/** The recording the adapter is driven with: five bytes of an ogg container it declares it accepts. */
const AUDIO_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]);

const REQUEST: AsrRequest = {
  audio: { bytes: AUDIO_BYTES, mimeType: 'audio/ogg', fileName: 'clip.ogg' },
};

/**
 * The stand-in transport for one fixture row: an answer, a refused connection, or a deadline.
 *
 * This is the ONLY transport any reading here runs on, and it is `AsrInvocation.fetchImpl` — the
 * adapter's own injected port — rather than a patched global, so a row measures the adapter's reading
 * of the bytes the row names and nothing about the process around it.
 */
function standInFor(row: FixtureRow): typeof fetch {
  return (async () => {
    if (row.drive === 'reject') throw new Error('connection refused');
    if (row.drive === 'abort') {
      const aborted = new Error('the deadline passed');
      aborted.name = 'AbortError';
      throw aborted;
    }
    return new Response(row.body, { status: row.status ?? 200 });
  }) as unknown as typeof fetch;
}

/** Drives the shipped adapter over one fixture row and reports the code it read. */
async function driveAdapter(adapter: AdapterModule, row: FixtureRow): Promise<string> {
  const invocation: AsrInvocation = {
    baseUrl: 'https://workspace.example',
    apiKey: 'k-criterion',
    model: 'm-criterion',
    timeoutMs: 1_000,
    fetchImpl: standInFor(row),
  };
  const result = await adapter.transcribe(REQUEST, invocation);
  return result.ok ? 'ok' : result.code;
}

/**
 * THE measurement: the vocabulary and the classifier under test, the table read two ways, every
 * fixture row answered by both the pure classifier and the shipped adapter, and the three adapters'
 * own texts.
 *
 * The shipping contract is entered with `await import(...)` BEFORE the adapter so that an arm
 * pointing the override at a mutated copy never re-initialises the shared instance; the adapter is
 * then driven through the same path its own relative specifier resolves to. `dashscope-omni` is the
 * adapter driven here because it is the one that reads an answer body back on a failure; the other
 * two are read as text, which is what AC5's table scan is for.
 */
async function measure(overrides: CriterionOverrides): Promise<Measurement> {
  const contractPath = overrides.contract ?? SHIPPING_CONTRACT_MODULE;
  const serviceSourcePath = overrides.serviceSource ?? SHIPPING_SERVICE_MODULE;

  await import(CONTRACT_MODULE_URL);
  const contract = (await import(pathToFileURL(contractPath).href)) as ContractModule;
  const adapter = (await import(pathToFileURL(DASHSCOPE_MODULE).href)) as AdapterModule;

  const pure: string[] = [];
  const adapterAnswered: string[] = [];
  for (const row of FIXTURES) {
    pure.push(
      row.via === 'pure' ? contract.classifyUpstreamFailure(row.status, row.body) : '(not-classifiable)',
    );
    adapterAnswered.push(await driveAdapter(adapter, row));
  }

  const adapterSources = ADAPTER_MODULES.map((adapterPath) => {
    const source = readFileSync(adapterPath, 'utf8');
    return {
      path: path.relative(REPO_ROOT, adapterPath),
      ownTable: carriesOwnCodeTable(source),
      delegates: codeLinesOf(source).some((line) => line.includes('classifyUpstreamFailure')),
    };
  });

  return {
    vocab: contract.ASR_ERROR_CODES,
    contractSource: readFileSync(contractPath, 'utf8'),
    tableRuntime: PROVIDER_ERROR_STATUS as Readonly<Record<string, number>>,
    tableSourceRows: tableRowsFromSource(readFileSync(serviceSourcePath, 'utf8')),
    pure,
    adapter: adapterAnswered,
    adapterId: adapter.id,
    adapterSources,
  };
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

type Measured = { value: string; ok: boolean };
type Reading = { name: string; run: (measurement: Measurement) => Measured };

const READINGS: readonly Reading[] = [
  // ── AC2: the fixture rows, code by code ───────────────────────────────────────────────────────
  {
    name: 'AC2 the fixture rows, code by code',
    run: (measurement) => {
      const lines = FIXTURES.map((row, index) => {
        const observed = row.via === 'pure' ? measurement.pure[index] : measurement.adapter[index];
        return `row=${rowLabel(row)} expected=${row.expected} observed=${observed} via=${row.via}`;
      });
      const matched = FIXTURES.filter((row, index) => {
        const observed = row.via === 'pure' ? measurement.pure[index] : measurement.adapter[index];
        return observed === row.expected;
      }).length;
      const fallback = measurement.pure[rowIndex(403, 'SomethingElse.New')];
      return {
        value: [
          ...lines,
          `rows=${FIXTURES.length} matched=${matched} unknown-code-fallback=${fallback}`,
        ].join('\n'),
        ok: matched === FIXTURES.length && FIXTURES.length === 19 && fallback === 'UNAUTHORIZED',
      };
    },
  },

  // ── AC3: same status, different codes ─────────────────────────────────────────────────────────
  {
    name: 'AC3 same status, different codes',
    run: (measurement) => {
      const codes400 = codesOf(measurement, indexesWithStatus(400));
      const codes429 = codesOf(measurement, indexesWithStatus(429));

      const codeAt = (status: number, code: string): string =>
        codesOf(measurement, [rowIndex(status, code)])[0];
      // Compared through a call rather than with `!==` inline: inside one `&&` chain the compiler
      // narrows each operand at the comparison that names it, so an inline `freeTier !== rateQuota`
      // after `freeTier === 'QUOTA_EXHAUSTED'` reads as two disjoint literals and does not compile.
      const differs = (left: string, right: string): boolean => left !== right;

      const arrearage = codeAt(400, 'Arrearage');
      const inspection = codeAt(400, 'DataInspectionFailed');
      const freeTier = codeAt(429, 'AllocationQuota.FreeTierOnly');
      const throttlingQuota = codeAt(429, 'Throttling.AllocationQuota');
      const rateQuota = codeAt(429, 'Throttling.RateQuota');
      // THE POSITIVE CONTROL. "Two rows differ" is also true of a comparison against nothing, and a
      // criterion that only ever asserted inequality could be satisfied by a classifier that answered
      // differently for every body it was handed. Two rows with DIFFERENT statuses and the SAME code
      // are the other end: the 401 that names a key and the 403 that names nothing are both the
      // refused credential, and they must read one code.
      const namedKey = codeAt(401, 'InvalidApiKey');
      const unnamed403 = codeAt(403, '(none)');

      return {
        value:
          `status=400 codes=${codes400.join(',')} status=429 codes=${codes429.join(',')} ` +
          `distinct400=${codes400.length} distinct429=${codes429.length} ` +
          `same-code-control=${String(namedKey === 'UNAUTHORIZED' && unnamed403 === namedKey)}`,
        ok:
          codes400.length >= 2 &&
          codes429.length === 2 &&
          differs(arrearage, inspection) &&
          freeTier === 'QUOTA_EXHAUSTED' &&
          throttlingQuota === 'QUOTA_EXHAUSTED' &&
          rateQuota === 'RATE_LIMITED' &&
          differs(freeTier, rateQuota) &&
          namedKey === 'UNAUTHORIZED' &&
          unnamed403 === namedKey,
      };
    },
  },

  // ── AC4: the table against the vocabulary, both ways ──────────────────────────────────────────
  {
    name: 'AC4 the status table against the vocabulary',
    run: (measurement) => {
      // Declared `string` rather than `AsrErrorCode`, because the two lists being compared are the
      // table's own key text and the vocabulary: the comparison is between TEXTS, and typing one side
      // as the union would make `includes` refuse a `string` the table is allowed to carry.
      const vocab: readonly string[] = [...measurement.vocab].sort();
      const runtime = Object.keys(measurement.tableRuntime).sort();
      const source = measurement.tableSourceRows.map((row) => row.code).sort();
      const missing = vocab.filter((code) => !source.includes(code));
      const extra = source.filter((code) => !vocab.includes(code));
      // The runtime index reading: every member must be answerable as a NUMBER, not merely present —
      // a row written as `undefined` would otherwise satisfy a key-set comparison.
      const unindexable = vocab.filter((code) => typeof measurement.tableRuntime[code] !== 'number');
      const rows = measurement.tableSourceRows.map((row) => `table-row ${row.code}=${row.status}`);

      return {
        value: [
          ...rows,
          `vocab=${vocab.length} table=${runtime.length} ` +
            `sameSet=${String(missing.length === 0 && extra.length === 0)} ` +
            `missing=[${missing.join(' ')}] extra=[${extra.join(' ')}] source=${source.length}`,
        ].join('\n'),
        ok:
          vocab.length === 14 &&
          missing.length === 0 &&
          extra.length === 0 &&
          unindexable.length === 0 &&
          runtime.join(' ') === vocab.join(' ') &&
          source.join(' ') === vocab.join(' '),
      };
    },
  },

  // ── AC5: the shipped adapter answers the same codes ───────────────────────────────────────────
  {
    name: 'AC5 the shipped adapter answers the same codes',
    run: (measurement) => {
      const adapterMatchesFixture = FIXTURES.filter(
        (row, index) => measurement.adapter[index] === row.expected,
      ).length;
      // The pure function and the shipped adapter must agree on every row the classifier can decide.
      // This is the reading that says there is ONE implementation: a second table inside the adapter
      // would show up here as a row where the two disagree, even where both happened to be right
      // about the fixture.
      const disagreements = FIXTURES.map((row, index) => ({
        row,
        pure: measurement.pure[index],
        adapter: measurement.adapter[index],
      })).filter((entry) => entry.row.via === 'pure' && entry.adapter !== entry.pure);
      const withTables = measurement.adapterSources.filter((entry) => entry.ownTable);
      const delegating = measurement.adapterSources.filter((entry) => entry.delegates);

      return {
        value: [
          `adapter=${measurement.adapterId || '(none)'} rows=${FIXTURES.length} ` +
            `adapter-vs-pure-same=${String(disagreements.length === 0)} ` +
            `per-adapter-tables=${withTables.length}`,
          ...measurement.adapterSources.map(
            (entry) =>
              `adapter-source ${entry.path} own-table=${String(entry.ownTable)} delegates=${String(entry.delegates)}`,
          ),
          ...disagreements.map(
            (entry) => `disagreement row=${rowLabel(entry.row)} adapter=${entry.adapter} pure=${entry.pure}`,
          ),
        ].join('\n'),
        ok:
          adapterMatchesFixture === FIXTURES.length &&
          disagreements.length === 0 &&
          withTables.length === 0 &&
          delegating.length === ADAPTER_MODULES.length,
      };
    },
  },

  // ── AC8: the vocabulary and its runtime list are one declaration ──────────────────────────────
  {
    name: 'AC8 the vocabulary and its runtime list are one declaration',
    run: (measurement) => {
      const source = measurement.contractSource;
      const declared = source.includes(ALIGNMENT_DECLARATION);
      // The declaration's TYPE is the reading: `Readonly<Record<AsrErrorCode, true>>` is what makes a
      // member left out of the literal a missing property and a key that is not a member an excess
      // one. The runtime list below it is derived from that literal, so a member added to the union
      // and left out of the literal fails `npm run typecheck` instead of reaching a run.
      const typedToTheUnion = source.includes(
        `${ALIGNMENT_DECLARATION}: Readonly<Record<AsrErrorCode, true>> = {`,
      );
      const runtimeDerived =
        source.includes('ASR_ERROR_CODES: readonly AsrErrorCode[] = Object.keys(') &&
        source.includes('ASR_ERROR_CODE_ALIGNMENT,');

      return {
        value:
          `alignment=${declared ? 'ASR_ERROR_CODE_ALIGNMENT' : '(absent)'} ` +
          'typecheck-reds-on-drift=not-measured-here ' +
          '(type-level: the record is declared Readonly<Record<AsrErrorCode, true>>, so a member left ' +
          'out of it is a missing property and a key that is not a member is an excess property, and ' +
          'ASR_ERROR_CODES is Object.keys() of that record rather than a second list — a member added ' +
          'to the union and left out of the record therefore fails npm run typecheck instead of ' +
          'reaching a run; the compiler run that shows it is AC8\'s drift case in ' +
          'voice-error-classification.false-forms.test.ts, which is where this task\'s subprocess ' +
          'budget lives, because AC1 requires this file to start none) ' +
          `declared=${String(declared)} typed-to-the-union=${String(typedToTheUnion)} ` +
          `runtime-derived=${String(runtimeDerived)} runtime-length=${measurement.vocab.length}`,
        ok: declared && typedToTheUnion && runtimeDerived && measurement.vocab.length === 14,
      };
    },
  },

  // ── AC9: what this task does not do ───────────────────────────────────────────────────────────
  {
    name: 'AC9 the scope this task does not cover',
    run: () => ({
      value:
        'scope: this task delivers the vocabulary, the one classifier in the contract, the three ' +
        'adapters wired to it, the code→status table and the falsifying forms, and nothing else — ' +
        'the ADR-004 vocabulary revision and the service\'s transport-failure comment are GOAL-011\'s ' +
        'contract task; the route body carrying code/upstreamCode is AC-150; the twelve locales are ' +
        'AC-151; the direct path sharing this classifier is AC-152; the real browser is AC-153; the ' +
        'voice.transcribe log line is unchanged (AC-143); recognition behaviour, PROMPT_VERSION and ' +
        'the model are untouched; no retry and no pre-upload silence check were added; acceptsMime ' +
        'and the code?: AsrErrorCode shape are unchanged; every reading above runs in-process under ' +
        'an injected transport, with no network, no real upstream and no subprocess (the exit-code ' +
        'readings AC7 names live in voice-error-classification.false-forms.test.ts), and two ' +
        'deviations in HOW that file measures are registered rather than hidden: its mutation copies ' +
        'are built under the gitignored tmp/ instead of beside the modules they copy (the AC8 drift ' +
        'mutant is type-invalid on purpose, and six sibling criteria run npm run typecheck ' +
        'concurrently), and its drift reading compiles that copy under the project\'s own compiler ' +
        'options via a tsconfig extending server/tsconfig.json rather than running npm run typecheck ' +
        'on a transiently drifted shipping file for the same reason',
      ok: true,
    }),
  },
];

/**
 * Runs every reading against one measurement, in order.
 *
 * TOTAL BY CONSTRUCTION: a reading that throws is reported as a failed reading carrying the failure's
 * message, because the falsifying file has to see WHICH reading noticed a mutation, and an exception
 * escaping the list would end the run at the first one instead.
 */
export async function collectReadings(overrides: CriterionOverrides = {}): Promise<ReadingOutcome[]> {
  const measurement = await measure(overrides);

  const outcomes: ReadingOutcome[] = [];
  for (const reading of READINGS) {
    let outcome: ReadingOutcome;
    try {
      const measured = reading.run(measurement);
      outcome = { name: reading.name, value: measured.value, ok: measured.ok };
    } catch (error) {
      outcome = {
        name: reading.name,
        value: `threw: ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      };
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

// ── the criterion, as `node:test` cases (registered only when this file is the entry point) ─────

const IS_ENTRY = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  let driven = 0;
  let measuredOnce: Promise<ReadingOutcome[]> | undefined;
  const readingsOnce = (): Promise<ReadingOutcome[]> => (measuredOnce ??= collectReadings());

  for (const reading of READINGS) {
    test(reading.name, async () => {
      const outcomes = await readingsOnce();
      const outcome = outcomes.find((entry) => entry.name === reading.name);
      assert.ok(outcome, `the reading list produced no outcome for '${reading.name}'`);
      driven += 1;
      // Printed BEFORE the assertion, so a red names itself and its measured value in the log rather
      // than only in the assertion's diff.
      process.stdout.write(`reading ${outcome.name} = ${outcome.value}\n`);
      assert.equal(outcome.ok, true, `reading '${outcome.name}' measured ${outcome.value}`);
    });
  }

  test('AC1 budget and scope', () => {
    const elapsed = Date.now() - STARTED_AT;
    const doors = openDoors();

    process.stdout.write(`elapsed-ms=${elapsed}\n`);
    process.stdout.write(
      `reading AC1 scope = elapsed-ms=${elapsed} subprocess-or-socket-imports=${doors.length} ` +
        `[${doors.join(' ')}] readings=${driven}/${READINGS_EXPECTED} offline-transport=injected\n`,
    );

    assert.equal(
      driven,
      READINGS_EXPECTED,
      `${driven} readings ran but READINGS_EXPECTED is ${READINGS_EXPECTED}: a reading was skipped, ` +
        'which reads exactly like a shorter green list',
    );
    assert.ok(elapsed < 15_000, `the criterion took ${elapsed}ms, past its own 15s budget`);
    assert.deepEqual(
      doors,
      [],
      `this criterion imports a module that can open a socket or start a process: ${doors.join(', ')}`,
    );
  });
}
