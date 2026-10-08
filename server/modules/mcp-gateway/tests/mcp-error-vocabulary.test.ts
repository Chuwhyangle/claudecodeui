/**
 * AC-285 criterion — the error-code vocabulary has ONE source, every tool
 * declares the codes it can return, and no code is dead.
 *
 * Everything below is real. A real express application carries the production
 * `/mcp` mount; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`, driven with a `node:http`-based fetch (the
 * sibling criteria's seam — `listen(0)` on this host lands on a port undici
 * refuses often enough to red a suite run at random). The transport is handed
 * every deps bag explicitly, so no database is needed.
 *
 * Readings, one leg each:
 *   (a) `MCP_ERROR_CODES` is the ONE vocabulary: its key set is pinned against an
 *       exhaustive `Record<McpErrorCode, true>` checklist (both directions), and
 *       every entry carries exactly `{ code, message, retryable }` — the code
 *       mirroring its key, an English sentence with no CJK, and a boolean;
 *   (b) a real `tools/list` is read back: the registry's name set equals
 *       `MCP_TOOL_ERROR_CODES`' keys, and each tool's
 *       `_meta['cloudcli/errorCodes']` deep-equals its declaration row — the
 *       declaration is read OFF THE WIRE, not from this file;
 *   (c) every code observed by AC-284's probes (the same 17 shallow
 *       invalid-argument probes, the same 17 scope denials, the same four
 *       class-envelope probes) belongs to the declaring tool's row AND to the
 *       vocabulary; every declared row is itself a subset of the vocabulary;
 *   (d) no code is dead: every vocabulary key is either TRIGGERED by a probe or
 *       listed in the machine-readable `{ code, reason }` exemption set, and no
 *       exemption is unreasoned;
 *   (e) a TypeScript compiler-API scan of every `server/modules/mcp-gateway/*.ts`
 *       (non-test) VALUE-position `code:` string literal finds only codes from the
 *       vocabulary; the two HTTP/OAuth bodies are exempt with a written reason;
 *       and the SAME scanner reports a synthetic out-of-vocabulary literal while
 *       staying silent on a type-position union and on a non-code-shaped literal
 *       (the positive and negative controls that prove the scan is not a no-op).
 *
 * The mutation triad this criterion must red on (AC7) is recorded against these
 * three legs: a tool returning an out-of-vocabulary code reds (c), an added
 * vocabulary code no probe triggers reds (d), and a hand-written value-position
 * string reds (e).
 *
 * Why TWO clients on the same mount. The SDK `Client` validates a call's
 * `structuredContent` against the tool's declared `outputSchema`, and it does so
 * even for an error result; the validators are cached only once `tools/list` has
 * run. So the ONE client that lists (`listClient`) is not the one that probes
 * (`probeClient`) — the prober's validator cache stays cold and every envelope
 * arrives verbatim. See AC-284's criterion for the full account.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import ts from 'typescript';

import type { TurnState } from '@/modules/providers/index.js';

import type {
  McpErrorCode,
  McpGatewayToolName,
  McpReadToolDeps,
  McpResidentToolDeps,
  McpWriteToolDeps,
} from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-error-vocabulary-test-secret';
delete process.env.VITE_IS_PLATFORM;

// Every failed probe below reaches the audited wrapper, which writes one
// `mcp_audit_log` row (AC-286 adds the `denied_scopes` column that row now
// carries). A file that writes audit rows needs a database with the CURRENT
// schema, so give it its own migrated temp DB rather than riding the ambient
// `DATABASE_PATH` — the ambient file is a developer's real DB, and one that
// predates a migration reds the insert with a bare "no such column".
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-error-vocabulary-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
await initializeDatabase();

const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const { MCP_ERROR_CODES, MCP_TOOL_ERROR_CODES, MCP_GATEWAY_PATH, mountMcpGateway } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;

// --------------------------- shared readings ---------------------------

const USER_ONE = 1;
const ALL_SCOPES: readonly string[] = [...ACCESS_TOKEN_SCOPES];

/** The code shape the whole gateway pins: an upper-snake identifier, nothing else. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/** CJK ideographs, kana and Hangul — the "non-empty ENGLISH" reading is "no CJK". */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
/** Every field one vocabulary entry may carry. */
const DESCRIPTOR_KEYS = ['code', 'message', 'retryable'];
/** The `_meta` key the transport attaches each tool's declared codes under. */
const ERROR_CODES_META_KEY = 'cloudcli/errorCodes';

/** The one line of evidence each reading prints. */
function say(line: string): void {
  console.log(`vocabulary ${line}`);
}

/**
 * The two-direction keyset pin for (a).
 *
 * Typed `Record<McpErrorCode, true>`, so a vocabulary code without a row here is
 * a COMPILE error (the type is derived from `MCP_ERROR_CODES` itself), and a row
 * that is not a vocabulary code is a compile error too. At RUNTIME the criterion
 * deep-equals the two key sets, which is what reds under mutation (ii) — `tsx`
 * strips types, so the runtime comparison is the assertion that actually fires.
 */
const EXPECTED_ERROR_CODES: Readonly<Record<McpErrorCode, true>> = {
  SESSION_NOT_FOUND: true,
  PROJECT_NOT_FOUND: true,
  TARGET_AMBIGUOUS: true,
  INVALID_ARGUMENT: true,
  UNKNOWN_TOOL: true,
  INSUFFICIENT_SCOPE: true,
  SESSION_BUSY: true,
  APPROVAL_NOT_FOUND: true,
  QUEUED_MESSAGE_NOT_FOUND: true,
  RUN_NOT_FOUND: true,
  MCP_TOOL_NOT_IMPLEMENTED: true,
  TASK_NOT_FOUND: true,
  UNSUPPORTED_PERMISSION_MODE: true,
  FORBIDDEN: true,
  INTERNAL_ERROR: true,
  APPROVAL_EXPIRED_OR_NOT_FOUND: true,
  // gap-mcp-ui-open-session: `ui_open_session`'s device-resolution and throttle
  // refusals. This criterion's mount leaves the tool's deps unwired, so it reads
  // the placeholder — the four are triggered by
  // `tests/mcp-ui-open-session.test.ts` (see the exemptions below).
  CLIENT_REQUIRED: true,
  NO_CLIENT: true,
  CLIENT_NOT_FOUND: true,
  RATE_LIMITED: true,
  // gap-mcp-draft-get-set-submit: `draft_submit` with nothing staged in the
  // session's composer. Triggered by the trigger probe below (the fixture's
  // draft store holds nothing), so it needs no exemption.
  DRAFT_EMPTY: true,
};

/**
 * The `code` values a probe must TRIGGER for the vocabulary to have no dead
 * entry (d), and the fixture each one needs. Every entry names the tool whose row
 * must declare the code, so the trigger doubles as extra (c) evidence.
 */
const TRIGGER_PROBES: ReadonlyArray<{ tool: string; args: AnyRecord; expect: string; why: string }> = [
  {
    tool: 'overview',
    args: { project: 'proj-1' },
    expect: 'MCP_TOOL_NOT_IMPLEMENTED',
    why: "the mount leaves the quay runner unwired, so overview's AC-245 body-table refusal runs",
  },
  {
    tool: 'projects_list',
    args: {},
    expect: 'INTERNAL_ERROR',
    why: 'the projects reader throws a bare Error, so the wrapper catch-all attributes no code',
  },
  {
    tool: 'session_cancel_queued',
    args: { session: 'sess-1', messageUuid: 'zzz-forbidden-withdrawal' },
    expect: 'FORBIDDEN',
    why: "the control service's withdrawal verdict is 'forbidden'",
  },
  {
    tool: 'session_background',
    args: { session: 'sess-1', stopTaskId: 'zzz-no-such-task' },
    expect: 'TASK_NOT_FOUND',
    why: 'the named stop task is absent from the host snapshot',
  },
  {
    tool: 'session_reconfigure',
    args: { session: 'sess-1', permissionMode: 'plan' },
    expect: 'UNSUPPORTED_PERMISSION_MODE',
    why: "the provider lists no permission modes, so 'plan' is unsupported",
  },
  {
    tool: 'draft_submit',
    args: { session: 'sess-1' },
    expect: 'DRAFT_EMPTY',
    why: 'the fixture draft store holds no text for sess-1, so the submit refuses before it reaches the control service',
  },
];

/**
 * The codes no probe in this criterion can trigger, each with the reason. (d)
 * accepts a vocabulary key that is triggered OR exempted; an exemption with no
 * reason is itself a failure.
 */
const CODE_EXEMPTIONS: ReadonlyArray<{ code: string; reason: string }> = [
  {
    code: 'UNKNOWN_TOOL',
    reason:
      "the SDK McpServer rejects an unregistered tool name with JSON-RPC -32602 BEFORE any gateway code runs, and the SDK client renders it as plain text with no structuredContent; there is no server-side seam to mint this code",
  },
  {
    code: 'APPROVAL_NOT_FOUND',
    reason:
      'declared for AC-287, which converts the approval-miss from a normal payload to an error; AC-285 may not mint it, so no probe triggers it yet',
  },
  {
    code: 'QUEUED_MESSAGE_NOT_FOUND',
    reason:
      'declared for AC-287, which converts the queued-message-miss from a normal payload to an error; AC-285 may not mint it, so no probe triggers it yet',
  },
  {
    code: 'RUN_NOT_FOUND',
    reason:
      'declared for AC-287, which converts the run-miss from a normal payload to an error; AC-285 may not mint it, so no probe triggers it yet',
  },
  {
    code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',
    reason:
      "approval_answer reports this INSIDE its normal success-shaped payload (not as an error envelope), and converting it is AC-287's; AC-285 only needed it in the vocabulary so the value-position literal that mints it points at one source (e)",
  },
  {
    code: 'CLIENT_REQUIRED',
    reason:
      "declared for gap-mcp-ui-open-session's `ui_open_session`; this criterion's mount leaves the tool's deps unwired (it reads the placeholder), so a single-call probe cannot reach the device-resolution refusal — `mcp-ui-open-session.test.ts` triggers it with two connected devices",
  },
  {
    code: 'NO_CLIENT',
    reason:
      "declared for gap-mcp-ui-open-session's `ui_open_session`; unreachable here for the same unwired-deps reason — `mcp-ui-open-session.test.ts` triggers it with an empty device roster",
  },
  {
    code: 'CLIENT_NOT_FOUND',
    reason:
      "declared for gap-mcp-ui-open-session's `ui_open_session`; unreachable here for the same unwired-deps reason — `mcp-ui-open-session.test.ts` triggers it by naming a device that is not connected",
  },
  {
    code: 'RATE_LIMITED',
    reason:
      "declared for gap-mcp-ui-open-session's `ui_open_session`; it needs SEVEN calls on one token inside the window, which no single-call probe can produce — `mcp-ui-open-session.test.ts` drives the throttle to the limit",
  },
];

// --------------------------- fixture identities ---------------------------

/** A released turn: no live tool, so the self-target guard never refuses. */
const IDLE_TURN: TurnState = { phase: 'idle', toolName: null, toolDurationMs: null };

const NO_SUCH_SESSION = 'zzz-no-such-session';
const NO_SUCH_PROJECT = 'zzz-no-such-project';
/** The `messageUuid` whose withdrawal verdict is `forbidden` (see the control stub). */
const FORBIDDEN_WITHDRAWAL = 'zzz-forbidden-withdrawal';

/**
 * The entries AC-246's gate resolves a `session` / `project` reference against.
 * `sess-1` is an exact id, which lets the trigger probes reach their handlers;
 * the two shared titles make the ambiguity class reachable.
 */
const resolveDeps = {
  listProjects: () => [
    { id: 'proj-1', title: 'Project one' },
    { id: 'proj-a', title: 'shared project alpha' },
    { id: 'proj-b', title: 'shared project beta' },
  ],
  listSessions: () => [
    { id: 'sess-1', title: 'Busy session' },
    { id: 'sess-a', title: 'shared session alpha' },
    { id: 'sess-b', title: 'shared session beta' },
  ],
};

// --------------------------- injected services ---------------------------

/**
 * The one control service every bag shares. `send` answers the busy reading
 * (`RUN_IN_PROGRESS`, which the tool normalizes to `SESSION_BUSY`);
 * `cancelQueued` answers `forbidden` for the one magic uuid and `unknown`
 * otherwise, so the FORBIDDEN trigger and the AC-287 "no such uuid" reading are
 * both reachable from one fixture.
 */
const control = {
  async send(): Promise<{ ok: false; code: 'RUN_IN_PROGRESS'; message: string }> {
    return { ok: false, code: 'RUN_IN_PROGRESS', message: 'A run is already in progress for this session.' };
  },
  async abort(): Promise<{ ok: false; aborted: false; code: 'SESSION_NOT_FOUND'; message: string }> {
    return { ok: false, aborted: false, code: 'SESSION_NOT_FOUND', message: 'No such session.' };
  },
  async cancelQueued(
    _caller: unknown,
    input: { messageUuid: string },
  ): Promise<'forbidden' | 'unknown'> {
    return input.messageUuid === FORBIDDEN_WITHDRAWAL ? 'forbidden' : 'unknown';
  },
};

/**
 * The composer-draft store the draft tools register over
 * (gap-mcp-draft-get-set-submit). It holds NO draft for any scope — which is
 * exactly the fixture the `DRAFT_EMPTY` trigger probe needs (a submit with
 * nothing staged) — and is inert for every other probe, none of which is one of
 * the three draft verbs.
 */
const draftStore = {
  getDrafts: (_userId: number) => [] as Array<{ scope: string; text: string; queuedMessage: unknown | null }>,
  saveDraft: (_userId: number, _scope: string, _draft: { text: string; queuedMessage: unknown | null }) =>
    undefined,
};

/**
 * The read bag. The project reader THROWS a bare Error on purpose: that is the
 * one way the wrapper's catch-all mints `INTERNAL_ERROR`, which (d) needs to
 * prove that code is not dead. The throwing stub is unreachable from the
 * invalid-argument probe (validation fails before the handler).
 */
const readTools = {
  projects: {
    getProjectsWithSessions: async () => {
      throw new Error('the projects reader is unavailable');
    },
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
  // gap-mcp-draft-get-set-submit: registering `draft_get` keeps `tools/list`
  // equal to the declaration keys (b) reads.
  draft: { drafts: draftStore },
  now: () => Date.now(),
} as unknown as McpReadToolDeps;

/** The write bag — every member present so all five tools register their REAL schemas. */
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
  sessionHostControl: {
    hosts: {
      start: async (sessionId: string) => ({
        ok: true as const,
        sessionId,
        hostId: 'ac285-host',
        mode: 'resident',
        pid: null,
        leases: [],
      }),
      close: (sessionId: string) => ({
        ok: true as const,
        sessionId,
        hostId: 'ac285-host',
        mode: 'resident',
        closeReason: 'user',
        leases: [],
      }),
      liveHost: () => null,
    },
  },
  // gap-mcp-draft-get-set-submit: registering `draft_set` / `draft_submit` over
  // the SAME `control` / `runs` this bag already carries keeps `tools/list` equal
  // to the declaration keys (b) reads, and makes the DRAFT_EMPTY trigger probe
  // reachable (it refuses before the control service is asked to send).
  draft: { drafts: draftStore },
} as unknown as McpWriteToolDeps;

/**
 * A session reader that resolves exactly `sess-1`, so the reconfigure /
 * background triggers reach their refusal branches.
 */
const sessionReader = {
  getSessionById: (sessionId: string) =>
    sessionId === 'sess-1' ? { provider: 'claude' } : null,
};

/**
 * The resident bag. Beyond the frozen `session_cancel_queued`, it wires the
 * reconfigure / background / approval services richly enough that their refusal
 * branches are reachable: an empty permission-mode matrix (so any mode is
 * unsupported), a live host binding holding no tasks (so any `stopTaskId` is
 * not-found), and an approvals control that answers the expired reading.
 */
const residentTools = {
  control,
  reconfigure: {
    sessions: sessionReader,
    runtime: { reconfigure: async () => 'next-turn' as const },
    models: {
      setSessionModel: () => undefined,
      setSessionEffort: () => undefined,
      setSessionPermissionMode: () => undefined,
    },
    capabilities: {
      getProviderCapabilities: () => ({ permissionModes: [] as string[] }),
      getRuntimeProviderCapabilities: () => ({}),
    },
  },
  background: {
    sessions: sessionReader,
    hosts: {
      liveHostForSession: (sessionId: string) =>
        sessionId === 'sess-1'
          ? { state: 'running', pid: 4242, bindings: new Map([[sessionId, { leases: [] }]]) }
          : null,
    },
    control: { stopTask: async () => 'requested' as const },
  },
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

const selfTarget = {
  readTurn: (): TurnState => IDLE_TURN,
  writeToolNames: ['session_send', 'session_create', 'session_interrupt', 'session_start', 'session_close'],
};

// --------------------------- HTTP: a node:http based fetch ---------------------------

/** The SDK client's `fetch`, implemented over `node:http`, so a port undici refuses cannot red this criterion. */
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

/** Boots one real `/mcp` mount whose authorize seam attaches a principal with `scopes`. */
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

let mountA: Mount;
let mountB: Mount;
/** The ONLY client that calls `tools/list`; warms its own output-validator cache, never a probe's. */
let listClient: Client;
/** The probe client: never lists, so its validator cache stays cold and envelopes arrive verbatim. */
let probeClient: Client;
/** The same deps behind a principal with NO scopes, for the scope-denial observations. */
let deniedClient: Client;

before(async () => {
  mountA = await startGateway(ALL_SCOPES);
  mountB = await startGateway([]);
  listClient = await connectClient(mountA.endpoint, 'ac285-registry');
  probeClient = await connectClient(mountA.endpoint, 'ac285-probe');
  deniedClient = await connectClient(mountB.endpoint, 'ac285-denied');
});

after(async () => {
  await listClient.close().catch(() => undefined);
  await probeClient.close().catch(() => undefined);
  await deniedClient.close().catch(() => undefined);
  await mountA.close();
  await mountB.close();
  closeConnection();
  rmSync(dbDirectory, { recursive: true, force: true });
});

// --------------------------- the probes ---------------------------

/**
 * AC-284's shallow probe per tool: the shallowest failure each tool has, so the
 * envelope comes from the wrapper's validation branch for all 17 at once. These
 * are rerun verbatim by (c) — the sequence AC-285 (c) calls "上一条的全部探针".
 */
const PROBE_TABLE: Record<string, AnyRecord> = {
  overview: { project: 5 },
  projects_list: { includeArchived: 'yes' },
  sessions_list: { state: 'bogus' },
  session_get: {},
  session_read: { session: 5 },
  run_get: { waitSeconds: 'soon' },
  quay_snapshot: { refresh: 'yes' },
  session_send: { session: 5, message: 'x' },
  session_create: {},
  session_interrupt: { session: 5 },
  session_start: {},
  session_close: { session: 5 },
  session_cancel_queued: { session: 5, messageUuid: 'uuid' },
  session_reconfigure: { session: 5 },
  session_background: { session: 5 },
  approvals_list: { session: 5 },
  approval_answer: {},
};

/** AC-284's four class-envelope probes — the readings that are NOT the wrapper's validation branch. */
const CLASS_ENVELOPE_PROBES: ReadonlyArray<{ tool: string; args: AnyRecord; expect: string }> = [
  { tool: 'session_get', args: { session: NO_SUCH_SESSION }, expect: 'SESSION_NOT_FOUND' },
  { tool: 'sessions_list', args: { project: NO_SUCH_PROJECT }, expect: 'PROJECT_NOT_FOUND' },
  { tool: 'session_get', args: { session: 'shared session' }, expect: 'TARGET_AMBIGUOUS' },
  { tool: 'session_send', args: { session: 'sess-1', message: 'hello' }, expect: 'SESSION_BUSY' },
];

// --------------------------- reading a call ---------------------------

type CallReading = { isError: boolean; structuredContent?: unknown; text?: string };

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

/** Asserts `reading` is the one envelope, optionally matching `expectedCode`, and returns its code. */
function assertEnvelope(reading: CallReading, label: string, expectedCode?: string): string {
  assert.equal(reading.isError, true, `${label}: a failure must set isError === true`);
  const sc = reading.structuredContent;
  assert.ok(
    typeof sc === 'object' && sc !== null,
    `${label}: a failure must carry a structuredContent object (no plain-text-only failures)`,
  );
  const code = (sc as AnyRecord).code;
  assert.equal(typeof code, 'string', `${label}: envelope.code must be a string`);
  assert.ok(CODE_PATTERN.test(code as string), `${label}: code "${String(code)}" must match ${String(CODE_PATTERN)}`);
  if (expectedCode !== undefined) {
    assert.equal(code, expectedCode, `${label}: expected code ${expectedCode}`);
  }
  return code as string;
}

// --------------------------- (c)/(d) shared observation sweep ---------------------------

/** One code a probe actually observed, and where. */
type Observation = { tool: string; code: string; where: string };

let observationPromise: Promise<Observation[]> | null = null;

/**
 * Runs AC-284's full probe set plus the (d) trigger probes ONCE and returns every
 * observed `{ tool, code }`. Memoized so (c) and (d) read the SAME sweep rather
 * than driving the mount twice.
 */
function collectObservations(): Promise<Observation[]> {
  if (observationPromise !== null) {
    return observationPromise;
  }
  observationPromise = (async () => {
    const observations: Observation[] = [];
    const record = async (client: Client, tool: string, args: AnyRecord, where: string): Promise<void> => {
      const reading = await call(client, tool, args);
      observations.push({ tool, code: assertEnvelope(reading, where), where });
    };

    // 1. AC-284's 17 shallow invalid-argument probes.
    for (const [tool, args] of Object.entries(PROBE_TABLE)) {
      await record(probeClient, tool, args, `invalid-argument/${tool}`);
    }
    // 2. AC-284's 17 scope denials (a token with no scopes).
    for (const tool of Object.keys(PROBE_TABLE)) {
      await record(deniedClient, tool, {}, `scope-denial/${tool}`);
    }
    // 3. AC-284's four class-envelope probes.
    for (const probe of CLASS_ENVELOPE_PROBES) {
      await record(probeClient, probe.tool, probe.args, `class/${probe.tool}`);
    }
    // 4. The (d) trigger probes.
    for (const probe of TRIGGER_PROBES) {
      await record(probeClient, probe.tool, probe.args, `trigger/${probe.tool}`);
    }
    return observations;
  })();
  return observationPromise;
}

// =====================================================================
// (a) the one vocabulary
// =====================================================================

test('(a) MCP_ERROR_CODES is the one vocabulary: keyset pinned both ways, every entry English + retryable', () => {
  const keys = Object.keys(MCP_ERROR_CODES).sort();
  assert.ok(keys.length > 0, 'the vocabulary must not be empty');

  // Both directions at runtime: a vocabulary code missing from the checklist, or a
  // checklist code missing from the vocabulary, reds here. The checklist's TYPE
  // (`Record<McpErrorCode, true>`) additionally makes this a compile-time fact.
  assert.deepEqual(
    keys,
    Object.keys(EXPECTED_ERROR_CODES).sort(),
    'the vocabulary keys and the McpErrorCode checklist must be the same set (no extra, no missing)',
  );

  for (const [key, descriptor] of Object.entries(MCP_ERROR_CODES)) {
    assert.deepEqual(
      Object.keys(descriptor).sort(),
      [...DESCRIPTOR_KEYS].sort(),
      `${key}: a vocabulary entry must carry exactly {code,message,retryable}`,
    );
    assert.equal(descriptor.code, key, `${key}: descriptor.code must mirror its own key`);
    assert.equal(typeof descriptor.message, 'string', `${key}: message must be a string`);
    assert.ok(descriptor.message.trim().length > 0, `${key}: message must not be empty`);
    assert.equal(
      CJK_PATTERN.test(descriptor.message),
      false,
      `${key}: message must be English (no CJK), saw ${JSON.stringify(descriptor.message)}`,
    );
    assert.equal(typeof descriptor.retryable, 'boolean', `${key}: retryable must be a boolean`);
  }

  say(`(a) vocabulary: ${keys.length} codes, each {code,message,retryable}, keyset pinned both ways`);
});

// =====================================================================
// (b) the declaration rides tools/list
// =====================================================================

test('(b) a real tools/list carries each tool\'s declared code set in _meta', async () => {
  const listed = await listClient.listTools();
  const registryNames = listed.tools.map((tool) => tool.name).sort();
  const declaredNames = Object.keys(MCP_TOOL_ERROR_CODES).sort();

  assert.ok(
    registryNames.length >= 17,
    `tools/list must return the full 17-tool set, got ${registryNames.length}`,
  );
  assert.deepEqual(
    registryNames,
    declaredNames,
    'the registry name set and the declaration keys must be the same set (a tool without a row, or a phantom row, reds here)',
  );
  assert.equal(new Set(registryNames).size, registryNames.length, 'the registry must not list a tool twice');

  for (const tool of listed.tools) {
    const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta;
    assert.ok(meta !== undefined, `${tool.name}: tools/list must carry _meta (the declaration is read off the wire)`);
    assert.ok(
      ERROR_CODES_META_KEY in meta,
      `${tool.name}: _meta must carry "${ERROR_CODES_META_KEY}"`,
    );
    const declared = [...MCP_TOOL_ERROR_CODES[tool.name as McpGatewayToolName]];
    assert.deepEqual(
      meta[ERROR_CODES_META_KEY],
      declared,
      `${tool.name}: _meta["${ERROR_CODES_META_KEY}"] must deep-equal its MCP_TOOL_ERROR_CODES row`,
    );
  }

  say(`(b) tools/list read back ${registryNames.length} tools, each carrying _meta["${ERROR_CODES_META_KEY}"]`);
});

// =====================================================================
// (c) observed ⊆ declared ⊆ vocabulary
// =====================================================================

test('(c) every observed code belongs to its tool declaration and to the vocabulary', async () => {
  const observations = await collectObservations();
  assert.ok(observations.length > 0, 'the probes must observe at least one code');

  const vocabulary = new Set<string>(Object.keys(MCP_ERROR_CODES));

  for (const { tool, code, where } of observations) {
    const declared = MCP_TOOL_ERROR_CODES[tool as McpGatewayToolName];
    assert.ok(declared !== undefined, `${where}: tool "${tool}" must have a MCP_TOOL_ERROR_CODES row`);
    assert.ok(
      (declared as readonly string[]).includes(code),
      `${where}: observed code ${code} must be declared by "${tool}" (declared: ${(declared as readonly string[]).join(', ')})`,
    );
    assert.ok(vocabulary.has(code), `${where}: observed code ${code} must be in MCP_ERROR_CODES`);
  }

  // The containment is also asserted on the STATIC table, not only on what a probe
  // happened to produce: every declared code is a vocabulary code.
  for (const [tool, codes] of Object.entries(MCP_TOOL_ERROR_CODES)) {
    for (const code of codes) {
      assert.ok(vocabulary.has(code), `"${tool}" declares ${code}, which is not in MCP_ERROR_CODES`);
    }
  }

  const tools = new Set(observations.map((observation) => observation.tool));
  say(`(c) ${observations.length} observed codes across ${tools.size} tools: all declared, all in-vocabulary`);
});

// =====================================================================
// (d) no dead code
// =====================================================================

test('(d) every vocabulary code is either triggered by a probe or explicitly exempted with a reason', async () => {
  const observations = await collectObservations();
  const triggered = new Set(observations.map((observation) => observation.code));
  const vocabulary = Object.keys(MCP_ERROR_CODES);

  // Non-vacuity: the sweep really triggered codes, and each trigger probe's code
  // is among them (a fixture that stopped reaching these branches must red here,
  // not silently shrink the triggered set).
  assert.ok(triggered.size > 0, 'the probe sweep must trigger at least one code');
  for (const probe of TRIGGER_PROBES) {
    assert.ok(
      triggered.has(probe.expect),
      `the trigger probe for ${probe.expect} (${probe.tool}) must actually observe it — ${probe.why}`,
    );
  }

  // Exemptions: machine-readable, reasoned, non-duplicating, and every one names a
  // vocabulary code.
  const exempted = new Set<string>();
  for (const exemption of CODE_EXEMPTIONS) {
    assert.ok(
      vocabulary.includes(exemption.code),
      `an exemption names ${exemption.code}, which is not in MCP_ERROR_CODES`,
    );
    assert.ok(exemption.reason.trim().length > 0, `exemption ${exemption.code} must state a reason`);
    assert.equal(exempted.has(exemption.code), false, `exemption ${exemption.code} must not be listed twice`);
    assert.equal(
      triggered.has(exemption.code),
      false,
      `${exemption.code} is BOTH triggered and exempt — drop the exemption`,
    );
    exempted.add(exemption.code);
  }

  const dead = vocabulary.filter((code) => !triggered.has(code) && !exempted.has(code));
  assert.deepEqual(
    dead,
    [],
    `these vocabulary codes are dead: neither a probe triggers them nor an exemption explains why (${dead.join(', ')})`,
  );

  const covered = vocabulary.filter((code) => triggered.has(code) || exempted.has(code));
  say(
    `(d) ${vocabulary.length} codes: ${covered.length - 0} covered (${triggered.size} triggered, ${exempted.size} exempted), 0 dead`,
  );
});

// =====================================================================
// (e) the source scan
// =====================================================================

/** One value-position `code:` string literal found by the scan. */
type ScanFinding = { file: string; line: number; code: string };

/**
 * Finds every VALUE-position `code: '<LITERAL>'` in `source` whose literal is
 * shaped like an error code.
 *
 * A TypeScript compiler-API walk over `PropertyAssignment` nodes named `code`
 * whose initializer is a string literal matching {@link CODE_PATTERN}. That node
 * choice is the whole point of the "type position vs value position" split: a
 * type-position union (`type T = { code: 'A' | 'B' }`) is a `PropertySignature`
 * inside a `TypeLiteral`, never a `PropertyAssignment`, so it is skipped rather
 * than mis-reported. A literal that is not code-shaped (the write-notification
 * `kind` string `agent.notification`) is skipped by the pattern.
 *
 * The SAME function is fed a synthetic source in the control below, so a scan
 * that silently stopped matching would fail the control rather than pass vacuously.
 */
function scanCodeLiterals(source: string, fileName: string): ScanFinding[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const findings: ScanFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      const isCodeName =
        (ts.isIdentifier(name) && name.text === 'code') ||
        (ts.isStringLiteral(name) && name.text === 'code');
      if (isCodeName && ts.isStringLiteral(node.initializer) && CODE_PATTERN.test(node.initializer.text)) {
        findings.push({
          file: fileName,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          code: node.initializer.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

/**
 * The two files whose value-position `code:` literal is an HTTP/OAuth body owned
 * by GOAL-026, not a gateway tool code. Exempted WITH a reason, and their findings
 * are pinned exactly so the exemption cannot silently grow.
 */
const HTTP_EXEMPT_FILES: Readonly<Record<string, { codes: readonly string[]; reason: string }>> = {
  'mcp-gateway.auth.ts': {
    codes: ['ACCESS_TOKEN_INVALID'],
    reason:
      'the 401 body of the token middleware; GOAL-024 excludes the OAuth/HTTP layer (owned by GOAL-026), so this code is not part of the gateway tool vocabulary',
  },
  'mcp-gateway.loopback.ts': {
    codes: ['MCP_LOOPBACK_ONLY'],
    reason:
      'the 403 body of the loopback guard; GOAL-024 excludes the OAuth/HTTP layer (owned by GOAL-026), so this code is not part of the gateway tool vocabulary',
  },
};

test('(e) the compiler-API scan proves value-position code literals come from the vocabulary', () => {
  const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceFiles = readdirSync(moduleDir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort();
  assert.ok(sourceFiles.length >= 10, `the scan must read the module's .ts files, found ${sourceFiles.length}`);

  const vocabulary = new Set<string>(Object.keys(MCP_ERROR_CODES));
  let nonExemptFindings = 0;

  for (const file of sourceFiles) {
    const findings = scanCodeLiterals(readFileSync(path.join(moduleDir, file), 'utf8'), file);
    const exempt = HTTP_EXEMPT_FILES[file];
    if (exempt !== undefined) {
      assert.deepEqual(
        findings.map((finding) => finding.code).sort(),
        [...exempt.codes].sort(),
        `${file}: the HTTP/OAuth exemption must cover exactly ${exempt.codes.join(', ')}`,
      );
      assert.ok(exempt.reason.trim().length > 0, `${file}: the HTTP/OAuth exemption must state a reason`);
      continue;
    }
    for (const finding of findings) {
      assert.ok(
        vocabulary.has(finding.code),
        `${file}:${finding.line} writes code "${finding.code}" in value position, which is not in MCP_ERROR_CODES`,
      );
      nonExemptFindings += 1;
    }
  }

  // Non-vacuity: the real sources DO contain scanned value-position literals, so a
  // scan that matched nothing cannot pass this leg.
  assert.ok(
    nonExemptFindings > 0,
    'the scan must find at least one non-exempt value-position code literal (otherwise (e) is vacuous)',
  );

  // Controls: the SAME scanner must report a synthetic out-of-vocabulary literal,
  // stay silent on a type-position union, and stay silent on a non-code-shaped
  // literal. These three together are what makes "the scan found nothing wrong"
  // mean something.
  const syntheticPositive = scanCodeLiterals(
    "const failure = { code: 'NOT_IN_THE_VOCABULARY', message: 'x' };\n",
    'synthetic-positive.ts',
  );
  assert.deepEqual(
    syntheticPositive.map((finding) => finding.code),
    ['NOT_IN_THE_VOCABULARY'],
    'the positive control: the scanner MUST report an out-of-vocabulary value-position literal',
  );

  const syntheticTypePosition = scanCodeLiterals(
    "type Failure = { code: 'TARGET_AMBIGUOUS' | 'SESSION_NOT_FOUND'; message: string };\n",
    'synthetic-type.ts',
  );
  assert.deepEqual(
    syntheticTypePosition,
    [],
    'the negative control: a TYPE-position union is not a value-position literal and must not be reported',
  );

  const syntheticNonCodeShape = scanCodeLiterals(
    "const notification = { kind: 'agent.notification', code: 'agent.notification' };\n",
    'synthetic-shape.ts',
  );
  assert.deepEqual(
    syntheticNonCodeShape,
    [],
    'the negative control: a non-code-shaped literal (lowercase/dotted) is not an error code and must not be reported',
  );

  say(
    `(e) scanned ${sourceFiles.length} files: ${nonExemptFindings} non-exempt value-position literals, all in-vocabulary; controls held`,
  );
});
