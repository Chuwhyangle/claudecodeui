/**
 * The gateway's INVALID_ARGUMENT / UNKNOWN_TOOL envelope (AC-288).
 *
 * Before this task the two most common failures a caller could hit left the
 * WORST residue on the wire:
 *
 *  - a bad argument was answered with the SDK's own text-only protocol error
 *    (`Input validation error: Invalid arguments for tool session_send: …` plus
 *    a rendered zod dump) and NO `structuredContent`, so a caller had to parse
 *    prose to learn which field was wrong;
 *  - an unregistered tool name was rejected with a JSON-RPC `-32602` before any
 *    gateway code ran, again as a bare sentence.
 *
 * AC-284 built the ONE envelope (`{ code, message, retryable, details? }` in
 * `structuredContent`) but could not reach either of those two paths: the
 * validation branch is the SDK's, and the unknown-name branch is the SDK's
 * `tools/call` handler. This criterion pins the AC-288 replacement: the gateway
 * installs its own `tools/call` dispatcher, validates each tool's REAL declared
 * schema itself, and renders both failures as that same envelope.
 *
 * What this file reads back, leg by leg:
 *
 *   (a) the five failure CLASSES — a missing argument, a wrong type, a value
 *       outside an enum, a value past a declared bound, and a mutually
 *       exclusive pair — each answer `isError === true` with
 *       `structuredContent.code === 'INVALID_ARGUMENT'` and a boolean
 *       `retryable`;
 *   (b) each carries `details.fields`: a NON-EMPTY array of exactly
 *       `{ path, problem }`, where every `problem` is a non-empty English
 *       reason (no CJK) and the reading AC-288 names literally —
 *       `{ path: 'message', problem: 'required' }` — is among them;
 *   (c) the envelope `message` is a short human sentence: at most 300
 *       characters, no CJK, no zod issue dump, no JSON/JSON-Schema blob, and
 *       never the SDK's `Input validation error:` text;
 *   (d) an unregistered name answers the SAME family with `UNKNOWN_TOOL`, and
 *       the SDK's `Tool X not found` sentence does not survive as the carrier;
 *   (e) the positive controls that keep the claim honest: legal calls to the
 *       very tools the failure classes probe are NOT errors, the advertised
 *       parameter SETS are unchanged, and the enum / bounds `tools/list`
 *       advertises are the enum / bounds the failure messages quote — one
 *       schema, two duties.
 *
 * Why a COLD client for every reading. The SDK `Client` validates a result's
 * `structuredContent` against the tool's declared `outputSchema` — and it does so
 * even when `isError` is true. Output validators are cached only when
 * `client.listTools()` runs, so `listClient` (the only client that lists) would
 * THROW `-32602 Structured content does not match the tool's output schema` on an
 * error envelope. Every probe therefore runs on `probeClient`, which never lists
 * and whose validator cache stays cold. Both clients reach the SAME stateless
 * mount (`createMcpServer` rebuilds the registry per request), so the name set
 * one reads is the name set the other calls.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { TurnState } from '@/modules/providers/index.js';

import type { McpReadToolDeps, McpResidentToolDeps, McpWriteToolDeps } from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-invalid-argument-test-secret';
delete process.env.VITE_IS_PLATFORM;

// Every failed probe below reaches the audited wrapper, which writes one
// `mcp_audit_log` row (AC-286 adds the `denied_scopes` column that row now
// carries). A file that writes audit rows needs a database with the CURRENT
// schema, so give it its own migrated temp DB rather than riding the ambient
// `DATABASE_PATH` — the ambient file is a developer's real DB, and one that
// predates a migration reds the insert with a bare "no such column".
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-invalid-argument-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
await initializeDatabase();

const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const { MCP_ERROR_CODES, MCP_GATEWAY_PATH, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const ALL_SCOPES: readonly string[] = [...ACCESS_TOKEN_SCOPES];

/** CJK ideographs, kana and Hangul — the "English" reading is "no CJK". */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
/** Every key the envelope may carry; `details` is the only optional one. */
const ENVELOPE_KEYS = new Set(['code', 'message', 'retryable', 'details']);
/** The gateway's one vocabulary — a code outside it means a second vocabulary grew. */
const KNOWN_CODES = new Set<string>(Object.keys(MCP_ERROR_CODES));
/** The longest message the envelope will carry. */
const MAX_MESSAGE_LENGTH = 300;
/**
 * The markers that would mean the message is a dump rather than a sentence: the
 * SDK's own prefix, zod's issue machinery, and the classic zod phrasing. A
 * lowercase `includes` scan, so casing cannot hide one.
 */
const DUMP_MARKERS: readonly string[] = [
  'input validation error',
  'zoderror',
  'zod',
  'invalid_type',
  'invalid_value',
  'too_small',
  'too_big',
  'received',
];

/** The one line of evidence each reading prints. */
function say(line: string): void {
  console.log(`invalid-argument ${line}`);
}

// --------------------------- resolvable targets ---------------------------

/**
 * The entries AC-246's gate resolves a `session` / `project` reference against.
 * `sess-1` is an exact id, so a legal read call reaches its handler instead of
 * being refused at the gate.
 */
const resolveDeps = {
  listProjects: () => [{ id: 'proj-1', title: 'Project one' }],
  listSessions: () => [{ id: 'sess-1', title: 'Busy session' }],
};

// --------------------------- injected services ---------------------------

/** The one control service every bag shares. No probe below reaches it. */
const control = {
  async send(): Promise<{ ok: false; code: 'RUN_IN_PROGRESS'; message: string }> {
    return { ok: false, code: 'RUN_IN_PROGRESS', message: 'A run is already in progress for this session.' };
  },
  async abort(): Promise<{ ok: false; aborted: false; code: 'SESSION_NOT_FOUND'; message: string }> {
    return { ok: false, aborted: false, code: 'SESSION_NOT_FOUND', message: 'No such session.' };
  },
  async cancelQueued(): Promise<'unknown'> {
    return 'unknown';
  },
};

/** Registered so the host tools declare their real schemas; never called here. */
const sessionHostControl = {
  hosts: {
    start: async (sessionId: string) => ({
      ok: true as const,
      sessionId,
      hostId: 'ac288-host',
      mode: 'resident',
      pid: null,
      leases: [],
    }),
    close: (sessionId: string) => ({
      ok: true as const,
      sessionId,
      hostId: 'ac288-host',
      mode: 'resident',
      closeReason: 'user',
      leases: [],
    }),
    liveHost: () => null,
  },
};

/**
 * The read bag. Every read answers an EMPTY result rather than a failure, which
 * is what makes leg (e)'s legal calls genuinely `isError === false` instead of
 * "a different error".
 */
const readTools = {
  projects: {
    getProjectsWithSessions: async () => [],
    getArchivedProjectsWithSessions: async () => [],
    getProjectSessionsPage: async () => ({ sessions: [], total: 0 }),
  },
  sessions: {
    listRecentSessions: () => ({ conversations: [], total: 0 }),
    readSessionLifecycle: () => null,
    fetchHistory: async () => ({ messages: [] }),
    fetchOutline: async () => ({ turns: [] }),
    fetchWindowAround: async () => ({ messages: [] }),
  },
  hosts: { snapshot: () => [], liveHostForSession: () => null },
  runs: { listRunningRuns: () => [] },
  now: () => Date.now(),
} as unknown as McpReadToolDeps;

/** The write bag. Only the schemas matter here — no write probe reaches a handler. */
const writeTools = {
  control,
  runs: { getRun: () => ({ runId: 'run-busy', source: 'mcp', status: 'running' }) },
  runGet: { deps: {}, build: async () => ({ outcome: 'timeout' }) },
  sessionCreate: {
    projects: { list: () => [] },
    sessions: { create: () => ({ sessionId: 'created' }), switchLifecycle: () => undefined },
    control,
    providers: { capabilities: () => ({}) },
  },
  sessionInterrupt: { control },
  sessionHostControl,
} as unknown as McpWriteToolDeps;

/** The resident bag: present so all 17 production tools register their real schemas. */
const residentTools = {
  control,
  reconfigure: {},
  background: {},
  approvals: {
    control: {
      pendingApprovals: async () => ({ approvals: [] }),
      answerApproval: async () => ({
        ok: false as const,
        code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',
        message: 'This approval has expired or no longer exists.',
      }),
    },
    now: () => 0,
  },
} as unknown as McpResidentToolDeps;

const IDLE_TURN: TurnState = { phase: 'idle', toolName: null, toolDurationMs: null };
const selfTarget = {
  readTurn: (): TurnState => IDLE_TURN,
  writeToolNames: ['session_send', 'session_create', 'session_interrupt', 'session_start', 'session_close'],
};

// --------------------------- HTTP: a node:http based fetch ---------------------------

/** The SDK client's `fetch`, over `node:http`, so a port undici refuses cannot red this criterion. */
const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

// --------------------------- the mount and its clients ---------------------------

type Mount = { endpoint: URL; close: () => Promise<void> };

/**
 * Boots one real `/mcp` mount with all scopes. An explicit `authorize` seam keeps
 * the real token middleware (and its database) out of this criterion; the scope
 * check is still the wrapper's, which is what puts the validation branch ahead of
 * it in the real path.
 */
async function startGateway(scopes: readonly string[]): Promise<Mount> {
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = { userId: USER_ONE, tokenId: 1, clientId: null, scopes: [...scopes] };
    next();
  };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize,
    readTools,
    writeTools,
    residentTools,
    resolveDeps,
    selfTarget,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One fresh SDK client over the endpoint. A client is a fresh output-validator cache. */
async function connectClient(endpoint: URL, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: nodeFetch });
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(transport);
  return client;
}

let mount: Mount;
/** The ONLY client that calls `tools/list`; warms its own output-validator cache, never a probe's. */
let listClient: Client;
/** The probe client: never lists, so its validator cache stays cold and envelopes arrive verbatim. */
let probeClient: Client;

before(async () => {
  mount = await startGateway(ALL_SCOPES);
  listClient = await connectClient(mount.endpoint, 'ac288-registry');
  probeClient = await connectClient(mount.endpoint, 'ac288-probe');
});

after(async () => {
  await listClient.close().catch(() => undefined);
  await probeClient.close().catch(() => undefined);
  await mount.close();
  closeConnection();
  rmSync(dbDirectory, { recursive: true, force: true });
});

// --------------------------- reading a call ---------------------------

type CallReading = {
  isError: boolean;
  structuredContent?: unknown;
  /** `content[0].text`, when the result carries one. */
  text?: string;
};

async function call(client: Client, tool: string, args: AnyRecord): Promise<CallReading> {
  const result = (await client.callTool({ name: tool, arguments: args } as Parameters<Client['callTool']>[0])) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    structuredContent?: unknown;
  };
  return {
    isError: result.isError === true,
    structuredContent: result.structuredContent,
    text: result.content?.[0]?.text,
  };
}

/**
 * Asserts `reading` is the one envelope and returns it. `label` names the probe so
 * a failure says WHICH tool/class broke, not just that something did.
 */
function assertEnvelope(reading: CallReading, label: string, expectedCode?: string): AnyRecord {
  assert.equal(reading.isError, true, `${label}: a failure must set isError === true`);
  const sc = reading.structuredContent;
  assert.ok(
    typeof sc === 'object' && sc !== null,
    `${label}: a failure must carry a structuredContent object (no plain-text-only failures)`,
  );
  const envelope = sc as AnyRecord;

  for (const key of Object.keys(envelope)) {
    assert.ok(ENVELOPE_KEYS.has(key), `${label}: envelope carries only {code,message,retryable,details?}, saw "${key}"`);
  }

  const code = envelope.code;
  assert.equal(typeof code, 'string', `${label}: envelope.code must be a string`);
  assert.ok(KNOWN_CODES.has(code as string), `${label}: code "${String(code)}" must be in the gateway's one vocabulary`);
  if (expectedCode !== undefined) {
    assert.equal(code, expectedCode, `${label}: expected code ${expectedCode}`);
  }
  assert.equal(typeof envelope.retryable, 'boolean', `${label}: envelope.retryable must be a boolean`);
  return envelope;
}

/** The `details.fields` array of an envelope, asserted to be a non-empty array of objects. */
function fieldsOf(envelope: AnyRecord, label: string): AnyRecord[] {
  const details = envelope.details;
  assert.ok(
    typeof details === 'object' && details !== null,
    `${label}: an INVALID_ARGUMENT envelope must carry details`,
  );
  const fields = (details as AnyRecord).fields;
  assert.ok(Array.isArray(fields), `${label}: details.fields must be an array`);
  assert.ok((fields as unknown[]).length > 0, `${label}: details.fields must not be empty`);
  for (const item of fields as unknown[]) {
    assert.ok(typeof item === 'object' && item !== null, `${label}: every field entry must be an object`);
  }
  return fields as AnyRecord[];
}

// --------------------------- the five failure classes ---------------------------

/** One failure class: the arguments that trigger it, and the field detail it must produce. */
type ClassCase = {
  label: string;
  tool: string;
  args: AnyRecord;
  /** The `{ path, problem }` this class must report, verbatim. */
  field: { path: string; problem: string };
};

/**
 * The five classes AC-288 names. Each uses a REAL registered tool and the
 * SHALLOWEST argument that reaches the class, so the reading is the wrapper's own
 * validation branch and not a handler's refusal.
 */
const CLASS_CASES: readonly ClassCase[] = [
  {
    label: 'missing required argument',
    tool: 'session_send',
    args: { session: 'sess-1' },
    field: { path: 'message', problem: 'required' },
  },
  {
    label: 'wrong argument type',
    tool: 'session_get',
    args: { session: 5 },
    field: { path: 'session', problem: 'expected string' },
  },
  {
    label: 'value outside an enum',
    tool: 'sessions_list',
    args: { state: 'bogus' },
    field: { path: 'state', problem: 'must be one of "running", "idle", "resident", "any"' },
  },
  {
    label: 'value past a declared bound',
    tool: 'session_read',
    args: { session: 'sess-1', limit: 9999 },
    field: { path: 'limit', problem: 'must be <= 200' },
  },
  {
    label: 'mutually exclusive arguments',
    tool: 'session_read',
    args: { session: 'sess-1', aroundId: 'turn-1', cursor: 'page-2' },
    field: { path: 'aroundId', problem: 'aroundId and cursor cannot be combined; name only one.' },
  },
];

/** The class case whose field path is `path`; a missing case is a broken table, not a soft skip. */
function classCaseFor(path: string): ClassCase {
  const found = CLASS_CASES.find((entry) => entry.field.path === path);
  assert.ok(found !== undefined, `the class table must carry a case reporting the ${path} field`);
  return found;
}

// =====================================================================
// (a)/(b) five classes, one envelope, one field list
// =====================================================================

test('(a)/(b) each of the five failure classes is one INVALID_ARGUMENT envelope with its field reasons', { concurrency: false }, async () => {
  assert.equal(new Set(CLASS_CASES.map((entry) => entry.label)).size, 5, 'the table must carry five distinct classes');
  // The reading AC-288 names literally is the FIRST case's, so pin it here: a
  // missing `message` reports exactly `{ path: 'message', problem: 'required' }`.
  assert.deepEqual(
    classCaseFor('message').field,
    { path: 'message', problem: 'required' },
    'AC-288 names this reading literally',
  );

  for (const probe of CLASS_CASES) {
    const reading = await call(probeClient, probe.tool, probe.args);
    const envelope = assertEnvelope(reading, `${probe.label} via ${probe.tool}`, 'INVALID_ARGUMENT');
    const fields = fieldsOf(envelope, probe.label);

    for (const field of fields) {
      assert.deepEqual(
        Object.keys(field).sort(),
        ['path', 'problem'],
        `${probe.label}: each field entry is exactly { path, problem }`,
      );
      assert.equal(typeof field.path, 'string', `${probe.label}: field.path must be a string`);
      assert.equal(typeof field.problem, 'string', `${probe.label}: field.problem must be a string`);
      assert.ok(
        String(field.problem).trim().length > 0,
        `${probe.label}: field.problem must not be empty`,
      );
      assert.equal(
        CJK_PATTERN.test(String(field.problem)),
        false,
        `${probe.label}: field.problem must be English (no CJK), saw ${JSON.stringify(field.problem)}`,
      );
    }

    const matched = fields.some(
      (field) => field.path === probe.field.path && field.problem === probe.field.problem,
    );
    assert.ok(
      matched,
      `${probe.label}: fields must contain ${JSON.stringify(probe.field)}, saw ${JSON.stringify(fields)}`,
    );
    say(`(a)/(b) ${probe.label}: ${probe.tool} -> ${JSON.stringify(fields)}`);
  }
});

// =====================================================================
// (c) the message is a sentence, never a dump
// =====================================================================

test('(c) the envelope message is a short human sentence, never a zod or JSON dump', { concurrency: false }, async () => {
  const readings: Array<{ label: string; reading: CallReading }> = [];
  for (const probe of CLASS_CASES) {
    readings.push({ label: probe.label, reading: await call(probeClient, probe.tool, probe.args) });
  }
  readings.push({ label: 'unknown tool', reading: await call(probeClient, 'no_such_tool_zzz', {}) });

  for (const { label, reading } of readings) {
    const envelope = assertEnvelope(reading, `message hygiene: ${label}`);
    const message = envelope.message;

    assert.equal(typeof message, 'string', `${label}: envelope.message must be a string`);
    assert.ok(String(message).trim().length > 0, `${label}: envelope.message must not be empty`);
    assert.ok(
      String(message).length <= MAX_MESSAGE_LENGTH,
      `${label}: envelope.message must be at most ${MAX_MESSAGE_LENGTH} characters, saw ${String(message).length}`,
    );
    assert.equal(
      CJK_PATTERN.test(String(message)),
      false,
      `${label}: envelope.message must be English (no CJK), saw ${JSON.stringify(message)}`,
    );

    const lowered = String(message).toLowerCase();
    for (const marker of DUMP_MARKERS) {
      assert.equal(
        lowered.includes(marker),
        false,
        `${label}: envelope.message must not carry the dump marker "${marker}", saw ${JSON.stringify(message)}`,
      );
    }
    assert.throws(
      () => JSON.parse(String(message)),
      `${label}: envelope.message must be a sentence, not a JSON blob`,
    );

    say(`(c) ${label}: ${String(message).length} chars, no dump markers`);
  }
});

// =====================================================================
// (d) an unregistered name is the same envelope family
// =====================================================================

test('(d) an unregistered tool name answers UNKNOWN_TOOL in the same envelope family', { concurrency: false }, async () => {
  const unknownName = 'no_such_tool_zzz';
  const listed = await listClient.listTools();
  assert.equal(
    listed.tools.some((tool) => tool.name === unknownName),
    false,
    'the probe name must genuinely be unregistered (non-vacuity)',
  );

  const reading = await call(probeClient, unknownName, {});
  const envelope = assertEnvelope(reading, 'unknown tool', 'UNKNOWN_TOOL');

  assert.equal(typeof reading.text, 'string', 'the envelope still mirrors its message in the text slot');
  assert.equal(
    reading.text,
    envelope.message,
    'the text slot mirrors the envelope message, not the SDK sentence',
  );
  assert.equal(
    (reading.text as string).includes('not found'),
    false,
    `the SDK's "Tool X not found" sentence must not survive as the carrier, saw ${JSON.stringify(reading.text)}`,
  );
  assert.equal(
    (reading.text as string).includes(unknownName),
    true,
    'the message names the tool the caller asked for, so the failure is actionable',
  );
  say(`(d) ${unknownName} -> ${String(envelope.code)} retryable=${String(envelope.retryable)}`);
});

// =====================================================================
// (e) positive controls: legal stays legal, and the schema is one truth
// =====================================================================

test('(e) legal calls stay legal and the advertised schema is the enforced one', { concurrency: false }, async () => {
  // 1. The positive control the negative legs need: the SAME tools the five
  // classes probe, called legally, must NOT be errors. `session_read` is probed
  // at its declared minimum, at its declared maximum, with `aroundId` alone (the
  // mutex must not make either key illegal by itself) and with every declared key.
  const legal: ReadonlyArray<{ label: string; tool: string; args: AnyRecord }> = [
    { label: 'projects_list', tool: 'projects_list', args: {} },
    { label: 'sessions_list with no arguments', tool: 'sessions_list', args: {} },
    { label: 'sessions_list with an in-enum state', tool: 'sessions_list', args: { state: 'any' } },
    { label: 'session_read defaults', tool: 'session_read', args: { session: 'sess-1' } },
    { label: 'session_read at the declared minimum', tool: 'session_read', args: { session: 'sess-1', limit: 1 } },
    { label: 'session_read at the declared maximum', tool: 'session_read', args: { session: 'sess-1', limit: 200 } },
    {
      label: 'session_read with every declared key',
      tool: 'session_read',
      args: { session: 'sess-1', mode: 'outline', limit: 5, before: 1, after: 1 },
    },
    { label: 'session_read with aroundId alone', tool: 'session_read', args: { session: 'sess-1', aroundId: 'turn-1' } },
  ];

  for (const probe of legal) {
    const reading = await call(probeClient, probe.tool, probe.args);
    assert.equal(
      reading.isError,
      false,
      `${probe.label}: a legal call must not be an error (envelope ${JSON.stringify(reading.structuredContent)})`,
    );
    say(`(e) legal: ${probe.label} -> isError=false`);
  }

  // 2. One schema, two duties: what `tools/list` advertises is what the wrapper
  // enforces. Reading the advertisement from the LISTING client and the failure
  // text from the PROBE client proves the two clients agree on one source.
  const listed = await listClient.listTools();
  const toolNamed = (name: string): AnyRecord => {
    const found = listed.tools.find((tool) => tool.name === name);
    assert.ok(found !== undefined, `tools/list must advertise ${name}`);
    return found as AnyRecord;
  };
  const propertiesOf = (name: string): AnyRecord => {
    const schema = toolNamed(name).inputSchema as AnyRecord;
    assert.equal(schema.type, 'object', `${name}: the advertised input schema must be an object schema`);
    return schema.properties as AnyRecord;
  };

  // The accepted parameter NAMES are unchanged by adding validation (AC-288 (e)).
  const declaredKeys: Record<string, readonly string[]> = {
    // `limit` joined the set in gap-mcp-sessions-list-limit-ignored, which
    // declared the bound this table reads back from `tools/list`.
    // `correlationId` joined in gap-mcp-correlation-id-write-tools-and-filters
    // (AC-337): the write tools ACCEPT the label and the two read filters
    // CONSUME it, so the advertised set here gains it on `sessions_list` (the
    // in-memory run filter) and on `session_send` (the label written to the run
    // and the audit row) — the same one-schema-two-duties rule, restated.
    sessions_list: ['project', 'state', 'correlationId', 'limit'],
    session_read: ['session', 'mode', 'limit', 'aroundId', 'before', 'after', 'cursor'],
    session_send: ['session', 'message', 'waitSeconds', 'correlationId'],
    session_get: ['session'],
    // gap-mcp-changes-on-demand-event-stream (AC-335): the incremental change
    // stream declares no required argument, so its five optional keys are the
    // whole advertised set — pinned here so the declared parameter names cannot
    // drift silently.
    changes: ['cursor', 'since', 'projects', 'kinds', 'limit'],
  };
  for (const [name, keys] of Object.entries(declaredKeys)) {
    assert.deepEqual(
      Object.keys(propertiesOf(name)).sort(),
      [...keys].sort(),
      `${name}: the advertised parameter set must be unchanged`,
    );
  }
  say(`(e) advertised parameter sets unchanged for ${Object.keys(declaredKeys).length} probed tools`);

  // The advertised enum IS the enforced enum: the failure message quotes exactly
  // the values `tools/list` advertises, in that order.
  const enumValues = (propertiesOf('sessions_list').state as AnyRecord).enum as unknown[];
  assert.ok(Array.isArray(enumValues), 'sessions_list.state must advertise its enum on tools/list');
  assert.equal(
    classCaseFor('state').field.problem,
    `must be one of ${enumValues.map((value) => JSON.stringify(value)).join(', ')}`,
    'the enum the failure quotes must be the enum tools/list advertises',
  );

  // The advertised BOUNDS are the enforced bounds: the maximum the failure quotes
  // is the maximum the accepted boundary call used, and both are what tools/list
  // says.
  const limit = propertiesOf('session_read').limit as AnyRecord;
  assert.equal(limit.type, 'integer', 'session_read.limit must advertise as an integer');
  assert.equal(typeof limit.minimum, 'number', 'session_read.limit must advertise a minimum');
  assert.equal(typeof limit.maximum, 'number', 'session_read.limit must advertise a maximum');
  assert.equal(
    classCaseFor('limit').field.problem,
    `must be <= ${String(limit.maximum)}`,
    'the bound the failure quotes must be the bound tools/list advertises',
  );
  assert.equal(
    limit.maximum,
    200,
    'the advertised maximum must be the bound the accepted boundary call used (limit: 200)',
  );
  say(`(e) advertised bounds limit in [${String(limit.minimum)}, ${String(limit.maximum)}] match the enforced ones`);
});
