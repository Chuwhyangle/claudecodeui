/**
 * AC-284 criterion — every MCP tool failure speaks ONE envelope:
 * `{ isError: true, structuredContent: { code, message, retryable, details? } }`.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`, driven with a `node:http`-based fetch (the
 * sibling criteria's seam — `listen(0)` on this host lands on a port undici
 * refuses often enough to red a suite run at random). The transport is handed
 * every deps bag explicitly, so no database is needed: the criterion is about
 * the SHAPE of a failure, and the resolvable-target fixture is the injected
 * `resolveDeps` list.
 *
 * Readings, one leg each:
 *   (a) `tools/list` names 20 tools; each has an error probe in the table and
 *       each of those probes answers `isError === true` with a `structuredContent`
 *       envelope whose `code` matches `^[A-Z][A-Z0-9_]*$` and is a member of the
 *       gateway's one code vocabulary, whose `message` is non-empty English, and
 *       whose `retryable` is a boolean;
 *   (b) no failure carries a plain-text body and none stuffs a JSON object into
 *       `content[0].text` — named explicitly for `session_read` (whose old
 *       not-found was a bare sentence) and `session_send` (whose old refusal was
 *       a JSON string in the text slot);
 *   (c) one class is ONE code: every "session not found" answer is
 *       `SESSION_NOT_FOUND` whichever tool produced it, "project not found" is
 *       `PROJECT_NOT_FOUND`, and the retired `TARGET_NOT_FOUND` literal no longer
 *       appears anywhere in the module sources;
 *   (d) the probe table is driven by the REGISTRY, not a hand-kept list: every
 *       name `tools/list` returns is covered by a probe (or, if ever needed, by
 *       an explicit exemption entry), and the table carries no name the registry
 *       does not.
 *
 * Why TWO clients on the same mount. The SDK `Client` validates a call's
 * `structuredContent` against the tool's declared `outputSchema` — and it does so
 * even when the result is an error (the guard comment says otherwise but the code
 * does not implement it). The output validators are cached only when
 * `client.listTools()` runs. So a client that has listed tools THROWS
 * `McpError -32602: Structured content does not match the tool's output schema`
 * on an error envelope for any output-schema-declaring tool. The registry reader
 * (`listClient`) is the only client that calls `tools/list`; every probe runs on
 * a separate client (`probeClient`) that never lists, so its validator cache is
 * cold and the envelope arrives verbatim. The two clients reach the SAME stateless
 * mount — `createMcpServer` rebuilds the registry per request from the same deps —
 * so the name set the reader sees is the name set the prober calls.
 *
 * The classes this task CANNOT envelope: none remain. Two used to be pinned here
 *   - 审批或排队消息不存在 / 运行不存在: converting them from "looks like success"
 *     to errors was explicitly AC-287's job, outside this task's scope. AC-287 has
 *     now landed, so both moved into the envelope arm above and the mount's read
 *     bag wires `run_get` so the 运行不存在 probe reads `RUN_NOT_FOUND` rather than
 *     the `MCP_TOOL_NOT_IMPLEMENTED` an unwired mount answers. The `exempt` arm is
 *     kept as the documented escape hatch for a class a future mount cannot
 *     envelope; today no class uses it.
 *
 * 未知工具 USED to be the third: the SDK's `McpServer` rejected an unregistered
 * name with a JSON-RPC `-32602` before any gateway code ran. AC-288 installs the
 * gateway's own `tools/call` dispatcher, so that name now reaches
 * `unknownToolResult` and answers the same envelope family as every other class —
 * which is why it moved into the envelope arm above.
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

import type { TurnState } from '@/modules/providers/index.js';

import type { McpReadToolDeps, McpResidentToolDeps, McpWriteToolDeps } from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-error-envelope-test-secret';
delete process.env.VITE_IS_PLATFORM;

// Every failed probe below reaches the audited wrapper, which writes one
// `mcp_audit_log` row (AC-286 adds the `denied_scopes` column that row now
// carries). A file that writes audit rows needs a database with the CURRENT
// schema, so give it its own migrated temp DB rather than riding the ambient
// `DATABASE_PATH` — the ambient file is a developer's real DB, and one that
// predates a migration reds the insert with a bare "no such column".
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-error-envelope-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
await initializeDatabase();

const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const { MCP_ERROR_CODES, MCP_GATEWAY_PATH, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const ALL_SCOPES: readonly string[] = [...ACCESS_TOKEN_SCOPES];

/** The code shape AC-284 pins: an upper-snake identifier, nothing else. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/** CJK ideographs, kana and Hangul — the "non-empty ENGLISH" reading is "no CJK". */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
/** Every key the envelope may carry; `details` is the only optional one. */
const ENVELOPE_KEYS = new Set(['code', 'message', 'retryable', 'details']);
// AC-285 reshaped the vocabulary into descriptors (`{ code, message, retryable }`),
// so the code set is the record's KEYS — the descriptor's `code` field mirrors its
// key, and AC-285's criterion pins that equality.
const KNOWN_CODES = new Set<string>(Object.keys(MCP_ERROR_CODES));

/** A released turn: no live tool, so the self-target guard never refuses. */
const IDLE_TURN: TurnState = { phase: 'idle', toolName: null, toolDurationMs: null };

/** The one line of evidence each reading prints. */
function say(line: string): void {
  console.log(`error-envelope ${line}`);
}

// --------------------------- resolvable targets ---------------------------

/**
 * The entries AC-246's gate resolves a `session` / `project` reference against.
 * Two titles share "shared session" and two share "shared project", which is what
 * makes the ambiguity class reachable; `sess-1` is an exact id, which is what lets
 * the busy probe reach the `session_send` handler instead of being refused at the
 * gate.
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

const NO_SUCH_SESSION = 'zzz-no-such-session';
const NO_SUCH_PROJECT = 'zzz-no-such-project';

// --------------------------- injected services ---------------------------

/**
 * The one control service every bag shares. `send` answers the busy reading
 * (`RUN_IN_PROGRESS`), which `session_send` must normalize to `SESSION_BUSY`;
 * `cancelQueued` answers `unknown`, the "no such uuid" reading AC-287 owns.
 */
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

/**
 * The host control the two host tools delegate to. Only the shape matters here:
 * every probe against `session_start` / `session_close` fails validation before
 * the handler, so these are never called.
 */
const sessionHostControl = {
  hosts: {
    start: async (sessionId: string) => ({
      ok: true as const,
      sessionId,
      hostId: 'ac284-host',
      mode: 'resident',
      pid: null,
      leases: [],
    }),
    close: (sessionId: string) => ({
      ok: true as const,
      sessionId,
      hostId: 'ac284-host',
      mode: 'resident',
      closeReason: 'user',
      leases: [],
    }),
    liveHost: () => null,
  },
};

/** The read bag. Overview / quay_snapshot stay unwired on purpose. */
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
  // `run_get` is wired HERE on purpose (AC-287 landed): the by-id read is what
  // routes the 运行不存在 class to its real RUN_NOT_FOUND envelope. Every id is
  // answered `unknown`/`unknown` — the "never issued" reading the class probe
  // pins. Without this bag the name answers the `MCP_TOOL_NOT_IMPLEMENTED`
  // refusal (AC-240/244/245) and the class probe would pin the wrong shape.
  runGet: {
    runs: {
      getRunById: () => ({ status: 'unknown' as const, reason: 'unknown' as const }),
      getRunBootId: () => null,
    },
    activity: { snapshot: () => null },
    sessions: { fetchHistory: async () => ({ messages: [] }) },
    now: () => 0,
    sleep: async () => undefined,
    bootId: () => 'boot-fixture',
  },
  now: () => Date.now(),
} as unknown as McpReadToolDeps;

/**
 * The write bag. `sessionCreate` / `sessionInterrupt` / `sessionHostControl` are
 * present so all five stage-4 tools register their REAL input schemas (a missing
 * member registers the placeholder's empty schema, which would make a missing-arg
 * probe look like a success). Only `session_send` reaches a handler.
 */
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

/**
 * The resident bag. `reconfigure` / `background` / `approvals` are present so
 * their four tools register alongside the frozen `session_cancel_queued`; the
 * approvals control answers the not-found reading as a NORMAL payload (the
 * AC-287 "looks like success" shape this criterion pins, not converts).
 */
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

/**
 * Boots one real `/mcp` mount whose authorize seam attaches a principal with
 * `scopes` — an explicit `authorize` keeps the real token middleware (and its
 * database) out of this criterion; the scope ENFORCEMENT is still the wrapper's,
 * which is the point.
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

let mountA: Mount;
let mountB: Mount;
/** The ONLY client that calls `tools/list`; warms its own output-validator cache, never a probe's. */
let listClient: Client;
/** The probe client: never lists, so its validator cache stays cold and envelopes arrive verbatim. */
let probeClient: Client;
/** The same deps behind a principal with NO scopes, for the 权限不足 class. */
let deniedClient: Client;

before(async () => {
  mountA = await startGateway(ALL_SCOPES);
  mountB = await startGateway([]);
  listClient = await connectClient(mountA.endpoint, 'ac284-registry');
  probeClient = await connectClient(mountA.endpoint, 'ac284-probe');
  deniedClient = await connectClient(mountB.endpoint, 'ac284-denied');
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

// --------------------------- the probe table ---------------------------

/** The ten classes AC-284 must probe. Order is documentation; only the SET is asserted. */
const PROBE_CLASSES = [
  '会话不存在',
  '项目不存在',
  '歧义',
  '参数缺失',
  '参数类型错',
  '未知工具',
  '权限不足',
  '会话忙',
  '审批或排队消息不存在',
  '运行不存在',
] as const;
type ProbeClass = (typeof PROBE_CLASSES)[number];

/** One error probe: what class it belongs to, the arguments, and the code it must carry. */
type ToolProbe = { probeClass: ProbeClass; args: AnyRecord; expect: string };

/**
 * One error probe per tool — the (d) coverage table. The registry's name set must
 * equal these keys exactly: a tool the registry grows without a probe here reds
 * (d), which is AC-284's "adding a registry tool must not go unnoticed" reading.
 *
 * Every entry deliberately uses the SHALLOWEST failure the tool has — a missing
 * required argument or a wrong-typed one — so the envelope is produced by the
 * wrapper's validation branch for all 24 at once. The classes that need a
 * particular tool and argument are probed separately in {@link CLASS_PROBES}.
 */
const PROBE_TABLE: Record<string, ToolProbe> = {
  overview: { probeClass: '参数类型错', args: { project: 5 }, expect: 'INVALID_ARGUMENT' },
  projects_list: { probeClass: '参数类型错', args: { includeArchived: 'yes' }, expect: 'INVALID_ARGUMENT' },
  sessions_list: { probeClass: '参数类型错', args: { state: 'bogus' }, expect: 'INVALID_ARGUMENT' },
  session_get: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  session_read: { probeClass: '参数类型错', args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  run_get: { probeClass: '参数类型错', args: { waitSeconds: 'soon' }, expect: 'INVALID_ARGUMENT' },
  quay_snapshot: { probeClass: '参数类型错', args: { refresh: 'yes' }, expect: 'INVALID_ARGUMENT' },
  session_send: { probeClass: '参数类型错', args: { session: 5, message: 'x' }, expect: 'INVALID_ARGUMENT' },
  session_create: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  session_interrupt: { probeClass: '参数类型错', args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  session_start: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  session_close: { probeClass: '参数类型错', args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  session_cancel_queued: {
    probeClass: '参数类型错',
    args: { session: 5, messageUuid: 'uuid' },
    expect: 'INVALID_ARGUMENT',
  },
  session_reconfigure: { probeClass: '参数类型错', args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  session_background: { probeClass: '参数类型错', args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  approvals_list: { probeClass: '参数类型错', args: { session: 5 }, expect: 'INVALID_ARGUMENT' },
  approval_answer: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  // `client` is a declared optional string, so a wrong-typed one fails the
  // wrapper's validation before any device resolution runs.
  ui_visible_context: { probeClass: '参数类型错', args: { client: 5 }, expect: 'INVALID_ARGUMENT' },
  // gap-ui-visible-context-extended-fields: `client` is the same declared optional
  // string, so a wrong-typed one fails the wrapper's validation before any device
  // resolution runs — and this tool's scope gate is a SUCCESS path (the
  // `'withheld'` marker), never an error envelope, so no second probe is needed.
  ui_selected_text: { probeClass: '参数类型错', args: { client: 5 }, expect: 'INVALID_ARGUMENT' },
  // `session` is a required declared string, so omitting it fails the wrapper's
  // validation before any device resolution or navigation runs.
  ui_open_session: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling navigation tools
  // each require `session` and their target id, so an empty call fails the
  // wrapper's validation before any device resolution or navigation runs.
  ui_focus_turn: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  ui_show_diff: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  ui_open_task: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  // `query` is a required declared string, so a wrong-typed one fails the
  // wrapper's validation before the search engine is reached.
  session_search: { probeClass: '参数类型错', args: { query: 5 }, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-usage-stats: `groupBy` is a REQUIRED enum, so omitting it fails the
  // wrapper's validation (INVALID_ARGUMENT) before the handler's SQL runs.
  mcp_usage_stats: { probeClass: '参数缺失', args: {}, expect: 'INVALID_ARGUMENT' },
  // gap-mcp-changes-on-demand-event-stream: `limit` is a DECLARED integer (with
  // a 1..200 bound), so a wrong-typed one fails the wrapper's validation
  // (INVALID_ARGUMENT) before the handler — wired or the unwired mount's
  // `notImplemented` refusal — is ever reached.
  changes: { probeClass: '参数类型错', args: { limit: 'x' }, expect: 'INVALID_ARGUMENT' },
};

/**
 * The explicit-exemption bucket (d) requires. It holds a reasoned entry for each
 * tool the registry lists that cannot be probed for a shallow failure: every such
 * tool declares no input, so the wrapper's validation branch has nothing to
 * reject, and every OTHER tool has a real error probe above. The bucket exists so
 * that saying "this tool cannot be probed" means a reasoned entry here rather
 * than deleting it from the table — and so (d)'s coverage check covers BOTH
 * buckets, not just the probe table.
 */
const EXEMPT_TOOLS: Record<string, string> = {
  // `ui_last_opened_session` takes NO arguments (it reads the browser's
  // last-opened pointer), so the audited wrapper's declared-input validation
  // branch — the shallowest failure every other tool is probed through — has
  // nothing to reject. Its handler-thrown NOT_FOUND envelope is exercised by its
  // own criterion (`mcp-ui-last-opened.test.ts`), not by this table.
  ui_last_opened_session:
    'declares no input arguments, so there is no INVALID_ARGUMENT probe to drive through the wrapper; its SESSION_NOT_FOUND envelope is covered by mcp-ui-last-opened.test.ts',
  // `ui_clients_list` likewise takes NO arguments (it lists every connected
  // device), so there is no shallow validation failure to drive, and with no
  // target reference either no AC-246 refusal is reachable. Its success payload
  // and its unresponsive-device reading are exercised by its own criterion
  // (`mcp-ui-clients-list.test.ts`).
  ui_clients_list:
    'declares no input arguments, so there is no INVALID_ARGUMENT probe to drive through the wrapper; with no target reference either, no AC-246 refusal is reachable, and its success payload is the criterion tests/mcp-ui-clients-list.test.ts',
};

/** A class probe: either a real envelope reading, or a reasoned exemption. */
type ClassProbe =
  | { kind: 'envelope'; mount: 'probe' | 'denied'; tool: string; args: AnyRecord; expect: string }
  | {
      kind: 'exempt';
      tool: string;
      args: AnyRecord;
      reason: string;
      reading: 'client-synthesized' | 'not-an-error' | 'not-plain-text';
    };

/** One probe per class. The `Record<ProbeClass, …>` type makes the ten keys a compile-time obligation. */
const CLASS_PROBES: Record<ProbeClass, ClassProbe> = {
  会话不存在: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'session_get',
    args: { session: NO_SUCH_SESSION },
    expect: 'SESSION_NOT_FOUND',
  },
  项目不存在: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'sessions_list',
    args: { project: NO_SUCH_PROJECT },
    expect: 'PROJECT_NOT_FOUND',
  },
  歧义: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'session_get',
    args: { session: 'shared session' },
    expect: 'TARGET_AMBIGUOUS',
  },
  参数缺失: { kind: 'envelope', mount: 'probe', tool: 'session_get', args: {}, expect: 'INVALID_ARGUMENT' },
  参数类型错: { kind: 'envelope', mount: 'probe', tool: 'overview', args: { project: 5 }, expect: 'INVALID_ARGUMENT' },
  // AC-288 moved this class out of the exemption bucket: the gateway now installs
  // its own `tools/call` dispatcher, so an unregistered name reaches
  // `unknownToolResult` and answers the SAME envelope family as every other
  // failure. The reading is asserted through the cold probe client, exactly like
  // the other classes — the SDK client would otherwise try to validate a
  // `structuredContent` against the (absent) cached output schema for a name
  // `tools/list` never mentioned.
  未知工具: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'no_such_tool',
    args: {},
    expect: 'UNKNOWN_TOOL',
  },
  权限不足: { kind: 'envelope', mount: 'denied', tool: 'session_get', args: {}, expect: 'INSUFFICIENT_SCOPE' },
  会话忙: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'session_send',
    args: { session: 'sess-1', message: 'hello' },
    expect: 'SESSION_BUSY',
  },
  // AC-287 landed: the "no such uuid" reading this exemption used to pin as a
  // normal payload is now a real envelope. The class moves into the envelope arm
  // — the assertion is strictly STRONGER than the retired `isError === false`
  // pin (it now asserts the code, not merely "not an error").
  审批或排队消息不存在: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'session_cancel_queued',
    args: { session: 'sess-1', messageUuid: 'no-such-uuid' },
    expect: 'QUEUED_MESSAGE_NOT_FOUND',
  },
  // AC-287 landed: a by-id read that names no run is now a real envelope, so this
  // class moves into the envelope arm. The fixture's `readTools.runGet` is wired
  // (above) precisely so the probe reads RUN_NOT_FOUND rather than an unwired
  // mount's MCP_TOOL_NOT_IMPLEMENTED refusal — the assertion is strictly STRONGER
  // than the retired "not plain text" pin (it now asserts the code).
  运行不存在: {
    kind: 'envelope',
    mount: 'probe',
    tool: 'run_get',
    args: { runId: 'zzz-no-such-run' },
    expect: 'RUN_NOT_FOUND',
  },
};

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
 * Asserts `reading` is the one envelope and returns its `code`. `label` names the
 * probe so a failure says WHICH tool/class broke, not just that something did.
 *
 * `expectedCode` is optional: the same-class legs read the code and compare codes
 * ACROSS tools, so they assert the shape here and the equality themselves.
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
  assert.ok(CODE_PATTERN.test(code as string), `${label}: code "${String(code)}" must match ${String(CODE_PATTERN)}`);
  assert.ok(KNOWN_CODES.has(code as string), `${label}: code "${String(code)}" must be in the gateway's one vocabulary`);
  if (expectedCode !== undefined) {
    assert.equal(code, expectedCode, `${label}: expected code ${expectedCode}`);
  }

  const message = envelope.message;
  assert.equal(typeof message, 'string', `${label}: envelope.message must be a string`);
  assert.ok(typeof message === 'string' && message.trim().length > 0, `${label}: envelope.message must not be empty`);
  assert.equal(
    CJK_PATTERN.test(message as string),
    false,
    `${label}: envelope.message must be English (no CJK), saw ${JSON.stringify(message)}`,
  );

  assert.equal(typeof envelope.retryable, 'boolean', `${label}: envelope.retryable must be a boolean`);
  if ('details' in envelope) {
    const details = envelope.details;
    assert.ok(
      typeof details === 'object' && details !== null,
      `${label}: envelope.details, when present, must be an object`,
    );
  }

  // (b) the anti-carrier rules: the text slot is never a JSON object carrying a
  // `code`, and the envelope is never carried by text alone (already proven by
  // structuredContent above, restated here as the explicit reading).
  if (typeof reading.text === 'string') {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(reading.text);
    } catch {
      parsed = null;
    }
    assert.ok(
      !(typeof parsed === 'object' && parsed !== null && 'code' in (parsed as AnyRecord)),
      `${label}: content[0].text must not be a JSON object carrying a "code" (JSON-in-text regression)`,
    );
  }

  return envelope;
}

// =====================================================================
// (d) the probe table is driven by the live registry
// =====================================================================

test('(d) the probe table covers exactly the tools the registry lists', async () => {
  const listed = await listClient.listTools();
  const registryNames = listed.tools.map((tool) => tool.name).sort();

  const covered = [...Object.keys(PROBE_TABLE), ...Object.keys(EXEMPT_TOOLS)].sort();

  // Non-vacuity: the registry really answered, and answered with the full set —
  // the read tools (including `changes`, the on-demand incremental read surface),
  // the write tools, and the `ui_*` navigation tools. A mount that registered
  // nothing would fail the equality below, not pass it.
  assert.equal(registryNames.length, 28, `tools/list must return the full 28-tool set, got ${registryNames.join(', ')}`);
  say(`(d) registry names: ${registryNames.join(', ')}`);

  assert.deepEqual(
    covered,
    registryNames,
    'every registered tool must appear in the probe table (a probe or an explicit exemption), and the table must carry no phantom name',
  );

  // No name may be in both buckets, and every exemption must state a reason.
  for (const name of Object.keys(EXEMPT_TOOLS)) {
    assert.equal(name in PROBE_TABLE, false, `${name} cannot be both probed and exempt`);
    assert.ok(EXEMPT_TOOLS[name].trim().length > 0, `${name}'s exemption must carry a reason`);
  }

  assert.equal(
    new Set(registryNames).size,
    registryNames.length,
    'the registry must not list the same tool twice (a duplicate would silently shrink the probe table)',
  );
});

// =====================================================================
// (a)/(b) every tool failure is one shaped envelope
// =====================================================================

test('(a)/(b) every tool failure is one shaped envelope, never plain text or JSON-in-text', async () => {
  for (const [tool, probe] of Object.entries(PROBE_TABLE)) {
    const reading = await call(probeClient, tool, probe.args);
    const envelope = assertEnvelope(reading, `tool ${tool} (${probe.probeClass})`, probe.expect);
    say(`(a) ${tool} -> ${String(envelope.code)} retryable=${String(envelope.retryable)}`);
  }
});

// =====================================================================
// (b) the two named regressions
// =====================================================================

test('(b) the named regressions: session_read was plain text, session_send was JSON-in-text', async () => {
  // `session_read` used to answer a bare sentence (`No session ...`) in
  // `content[0].text` for a target that does not resolve. It must now be the
  // envelope, and the sentence must not survive as the carrier.
  const read = await call(probeClient, 'session_read', { session: NO_SUCH_SESSION });
  const readEnvelope = assertEnvelope(read, 'regression session_read (was plain text)', 'SESSION_NOT_FOUND');
  assert.equal(typeof read.text, 'string', 'the envelope still mirrors its message in the text slot');
  assert.notEqual(read.text, undefined, 'the text slot is present but is no longer the sole carrier');
  say(`(b) session_read -> ${String(readEnvelope.code)} (was a bare sentence in content[0].text)`);

  // `session_send` used to throw a JSON-encoded refusal that the SDK rendered as
  // a JSON STRING in `content[0].text`. The busy path is where that refusal came
  // from, so it is the regression probe: the code must be in `structuredContent`,
  // never parsed back out of the text slot.
  const send = await call(probeClient, 'session_send', { session: 'sess-1', message: 'hello' });
  const sendEnvelope = assertEnvelope(send, 'regression session_send (was JSON-in-text)', 'SESSION_BUSY');
  const sendDetails = sendEnvelope.details as AnyRecord | undefined;
  assert.equal(sendDetails?.runId, 'run-busy', 'SESSION_BUSY must name the in-flight run in details');
  assert.equal(
    sendEnvelope.retryable,
    true,
    'SESSION_BUSY is retryable — the run in progress is a transient condition, unlike a missing target',
  );
  say(`(b) session_send -> ${String(sendEnvelope.code)} details.runId=${String(sendDetails?.runId)} (was a JSON string in content[0].text)`);
});

// =====================================================================
// (c) one class is one code
// =====================================================================

test('(c) one class is one code across every tool', async () => {
  const codeFor = async (tool: string, args: AnyRecord, label: string): Promise<string> => {
    const reading = await call(probeClient, tool, args);
    const envelope = assertEnvelope(reading, label);
    return String(envelope.code);
  };

  // "session not found" is ONE code whichever tool answers it. The three tools
  // below reach the reading from three different code paths (the read tool's
  // gate, the write tool's gate, and the tool body's own refusal), which is
  // exactly the drift AC-284 removes.
  const sessionNotFound = [
    await codeFor('session_get', { session: NO_SUCH_SESSION }, 'c/session_get not-found'),
    await codeFor('session_read', { session: NO_SUCH_SESSION }, 'c/session_read not-found'),
    await codeFor('session_send', { session: NO_SUCH_SESSION, message: 'x' }, 'c/session_send not-found'),
    await codeFor('session_interrupt', { session: NO_SUCH_SESSION }, 'c/session_interrupt not-found'),
  ];
  for (const code of sessionNotFound) {
    assert.equal(code, 'SESSION_NOT_FOUND', `every "session not found" answer must be SESSION_NOT_FOUND, saw ${code}`);
  }
  say(`(c) session-not-found is SESSION_NOT_FOUND across ${sessionNotFound.length} tools`);

  // "project not found" likewise.
  const projectNotFound = [
    await codeFor('sessions_list', { project: NO_SUCH_PROJECT }, 'c/sessions_list project not-found'),
    await codeFor('session_create', { project: NO_SUCH_PROJECT }, 'c/session_create project not-found'),
  ];
  for (const code of projectNotFound) {
    assert.equal(code, 'PROJECT_NOT_FOUND', `every "project not found" answer must be PROJECT_NOT_FOUND, saw ${code}`);
  }
  say(`(c) project-not-found is PROJECT_NOT_FOUND across ${projectNotFound.length} tools`);

  // Ambiguity is one code for both kinds.
  const ambiguous = [
    await codeFor('session_get', { session: 'shared session' }, 'c/session_get ambiguous'),
    await codeFor('sessions_list', { project: 'shared project' }, 'c/sessions_list ambiguous'),
  ];
  for (const code of ambiguous) {
    assert.equal(code, 'TARGET_AMBIGUOUS', `every ambiguous target must be TARGET_AMBIGUOUS, saw ${code}`);
  }
  say('(c) ambiguity is TARGET_AMBIGUOUS for both session and project');

  // Input validation is one code for both a missing argument and a wrong type.
  const invalid = [
    await codeFor('session_get', {}, 'c/session_get missing arg'),
    await codeFor('session_start', {}, 'c/session_start missing arg'),
    await codeFor('overview', { project: 5 }, 'c/overview wrong type'),
    await codeFor('session_close', { session: 5 }, 'c/session_close wrong type'),
  ];
  for (const code of invalid) {
    assert.equal(code, 'INVALID_ARGUMENT', `every input-validation failure must be INVALID_ARGUMENT, saw ${code}`);
  }
  say('(c) input validation is INVALID_ARGUMENT for missing args and wrong types alike');

  // The retired second name for "the session does not exist" must be gone from
  // the module sources — the same glob AC-284's (c) names. The scan is
  // non-recursive, so this criterion (under `tests/`) is not scanned; the
  // positive controls prove the scan actually read source files.
  const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceFiles = readdirSync(moduleDir).filter((entry) => entry.endsWith('.ts'));
  assert.ok(sourceFiles.length >= 10, `the source scan must read the module's .ts files, found ${sourceFiles.length}`);

  let sessionNotFoundMentions = 0;
  const retiredMentions: string[] = [];
  for (const file of sourceFiles) {
    const source = readFileSync(path.join(moduleDir, file), 'utf8');
    sessionNotFoundMentions += source.split('SESSION_NOT_FOUND').length - 1;
    if (source.includes('TARGET_NOT_FOUND')) {
      retiredMentions.push(file);
    }
  }
  assert.ok(sessionNotFoundMentions > 0, 'the scan must actually find SESSION_NOT_FOUND (positive control)');
  assert.deepEqual(
    retiredMentions,
    [],
    'TARGET_NOT_FOUND must no longer appear in the module sources — one category, one code',
  );
  say(
    `(c) retired TARGET_NOT_FOUND absent from ${sourceFiles.length} source files; SESSION_NOT_FOUND present ${sessionNotFoundMentions}x`,
  );
});

// =====================================================================
// the ten classes
// =====================================================================

test('the ten probe classes are all exercised', () => {
  assert.deepEqual(
    Object.keys(CLASS_PROBES).sort(),
    [...PROBE_CLASSES].sort(),
    'CLASS_PROBES must carry exactly the ten classes AC-284 names — a dropped class must red, not vanish',
  );
  for (const [probeClass, probe] of Object.entries(CLASS_PROBES)) {
    assert.ok(
      probe.args !== null && typeof probe.args === 'object',
      `${probeClass}: every class probe must name real arguments`,
    );
    if (probe.kind === 'exempt') {
      assert.ok(probe.reason.trim().length > 0, `${probeClass}: an exemption must state why it cannot be enveloped here`);
    }
  }
});

test('each class probe reads the shape its class promises', async () => {
  for (const [probeClass, probe] of Object.entries(CLASS_PROBES)) {
    if (probe.kind === 'envelope') {
      const client = probe.mount === 'denied' ? deniedClient : probeClient;
      const reading = await call(client, probe.tool, probe.args);
      const envelope = assertEnvelope(reading, `class ${probeClass} via ${probe.tool}`, probe.expect);
      say(`class ${probeClass} -> ${String(envelope.code)} (${probe.tool}, ${probe.mount})`);
      continue;
    }

    // The exemption arm: a class a mount cannot envelope pins its CURRENT shape
    // so a silent change reds, naming the owner of the conversion the criterion
    // does not perform. It is presently unused — AC-288 (未知工具) and AC-287
    // (审批或排队消息不存在, 运行不存在) moved their classes into the envelope arm
    // above — but kept as the documented escape hatch (the class-coverage test
    // still guards that any entry here states a reason).
    const reading = await call(probeClient, probe.tool, probe.args);
    if (probe.reading === 'not-an-error') {
      assert.equal(
        reading.isError,
        false,
        `${probeClass}: this class is not yet an error; it must remain a normal payload`,
      );
      say(`class ${probeClass} -> normal payload (${probe.tool}), a later task owns the conversion`);
    } else {
      // 'not-plain-text': whatever it answers, a failure must never be a bare
      // text body — that is the regression AC-284 exists to prevent.
      assert.ok(
        reading.isError === false || (typeof reading.structuredContent === 'object' && reading.structuredContent !== null),
        `${probeClass}: a failure must never be plain text alone (${probe.tool})`,
      );
      say(`class ${probeClass} -> ${reading.isError ? 'structured failure' : 'normal payload'} (${probe.tool})`);
    }
  }
});

// =====================================================================
// 权限不足: every tool refuses with the one scope code
// =====================================================================

test('权限不足: every registered tool refuses with INSUFFICIENT_SCOPE on a token with no scopes', async () => {
  const names = Object.keys(PROBE_TABLE);
  const codes: string[] = [];
  for (const tool of names) {
    const reading = await call(deniedClient, tool, {});
    const envelope = assertEnvelope(reading, `scope denial ${tool}`, 'INSUFFICIENT_SCOPE');
    codes.push(String(envelope.code));
  }
  assert.deepEqual(
    new Set(codes),
    new Set(['INSUFFICIENT_SCOPE']),
    'every tool must refuse an unscoped token with the SAME code',
  );
  say(`权限不足: ${names.length} tools all refuse INSUFFICIENT_SCOPE`);
});
