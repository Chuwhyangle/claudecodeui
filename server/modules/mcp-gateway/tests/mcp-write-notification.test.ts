/**
 * AC-303 criterion: an EXTERNAL MCP client that successfully calls one of the
 * gateway's WRITE tools pushes the token's owner one low-noise notification —
 * client name, tool name, session title and the first 40 characters of the
 * message, never the token, the full message or an argument secret. Read-only
 * tools, denied calls and erroring calls notify nobody; one client's writes
 * merge inside a 60-second window; the UI WebSocket and scheduled send paths
 * never notify; and a notifier that throws cannot change the tool call's result.
 *
 * Everything below is real except the runtime's `run` (a parked promise) and the
 * non-`session_send` write tools' back-end services (small stubs). A real
 * express 4 application carries the production `/mcp` mount (`createMcpGateway-
 * Module` → `mountMcpGateway`) behind the production token middleware; the
 * client is the MCP SDK's own `Client` over `StreamableHTTPClientTransport`; the
 * database is a real better-sqlite3 file in a temp directory; the SHARED control
 * service is the real `createChatControlService` the WebSocket gateway and the
 * scheduled dispatcher also drive. The notification seam is the PRODUCTION
 * assembly `createMcpWriteNotification` over an injected recording sink and a
 * fake clock, so the merge window is observed without waiting on wall time.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/244/245/248/249/271/272/273/274's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) the write set is DERIVED from `tools/list` (`annotations.readOnlyHint
 *       === false`); every write tool is called once and notifies exactly once
 *       (`count: 1`) with the four facts and nothing else;
 *   (b) a read-only tool's `ok`, a scope-denied write and a handler-that-throws
 *       write each leave the spy untouched and their own audit row (`ok` /
 *       `denied` / `error`);
 *   (c) six writes by one client inside the fake 60s window → five individual
 *       notifications then ONE summary with the cumulative count; past the
 *       window, individual notifications resume;
 *   (d) the shared control service driven with `via: 'websocket'` and `via:
 *       'scheduled'` notifies nobody, while one `/mcp` write call notifies once;
 *   (e) a throwing notifier leaves the HTTP payload and the `ok` audit row
 *       byte-for-byte identical to the non-throwing arm.
 *
 * The false forms (the task's mutations) mutate the implementation after this
 * criterion is green; they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpWriteNotificationPayload, McpWriteNotifier, UiNavigationToolDeps } from '../index.js';

// --------------------------------------------------------------------------
// A scratch HOME is set before any aliased module is imported, so settings reads
// land on an empty directory (the posture AC-244/249/274's criteria take).
// --------------------------------------------------------------------------
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-write-notification-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-write-notification-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { ACCESS_TOKEN_SCOPES, createAccessTokensService } = await import('@/modules/oauth/index.js');
const { chatRunRegistry, createChatControlService } = await import('@/modules/websocket/index.js');
const {
  MCP_GATEWAY_PATH,
  MCP_STAGE4_WRITE_TOOLS,
  buildRunGet,
  createMcpAuthMiddleware,
  createMcpGatewayModule,
  createMcpWriteNotification,
  mountMcpGateway,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;
type ChatControlService = ReturnType<typeof createChatControlService>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
/** The clock the approval tools read; pinned so nothing in this file waits. */
const NOW = 1_700_000_000_000;
/** The project `session_create` resolves, and the session it hands back. */
const PROJECT_ID = 'proj-1';
const CREATED_SESSION_ID = 'sess-created';
/** The parked-write session `session_send` dispatches onto. */
const SEND_SESSION = 'sess-send';
/** The two sessions the direct (non-MCP) control sends drive. */
const WS_SESSION = 'sess-ws';
const SCHED_SESSION = 'sess-sched';
/** The general target the remaining write tools act on. */
const TARGET = 'sess-target';
/** The pending approval `approval_answer` decides. */
const REQUEST_ID = 'req-ac303';

const SEND_TITLE = 'AC303 发送目标';
const WS_TITLE = 'AC303 WebSocket 目标';
const SCHED_TITLE = 'AC303 定时目标';
const TARGET_TITLE = 'AC303 通用目标';

/** A message longer than the 40-character preview, so the tail must not leak. */
const MESSAGE_HEAD = 'HEAD'.repeat(10); // exactly 40 characters
const MESSAGE_TAIL = '-TAIL-MUST-NOT-LEAK-0123456789';
const LONG_MESSAGE = `${MESSAGE_HEAD}${MESSAGE_TAIL}`;

/** An argument value that must never reach the payload (`args` 授权码/密钥). */
const ARG_SECRET = 'SECRET-AUTH-CODE-VALUE';

/**
 * The FULL write token's stored `name`. `createMcpWriteNotification`'s default
 * client-name reader names a personal access token by its OWN row name (the
 * token is the caller's identity — it has no OAuth client), so this is the name
 * every write call's payload carries.
 */
const FULL_TOKEN_NAME = 'ac303-full';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`mcp-write-notification ${line}`);
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

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

// --------------------------- tool result parsing ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
  } catch {
    payload = null;
  }
  return { isError: call.isError === true, text, payload };
}

/** An audit row as this criterion reads it back. */
type AuditRow = { id: number; tool: string; outcome: string };

// --------------------------- the controlled runtime ---------------------------

type PendingSeed = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  context: unknown;
  receivedAt: Date;
};

/**
 * The runtime gateway the real control service is handed. `hasRuntime` is true,
 * `run` parks until the harness releases it (so a send returns while the run is
 * nominally in flight), and the approval verbs read a mutable seed. Only the
 * members the control verbs touch are implemented.
 */
function createControlledRuntime() {
  const parked: Array<() => void> = [];
  const runCalls: Array<{ provider: string; command: string; options: AnyRecord }> = [];
  let pending: PendingSeed[] = [];

  const runtime = {
    hasRuntime: () => true,
    run: (provider: string, command: string, options: AnyRecord) => {
      runCalls.push({ provider, command, options });
      return new Promise((resolve) => {
        parked.push(() => resolve(undefined));
      });
    },
    abort: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: (sessionId: string) =>
      pending.filter((entry) => entry.sessionId === sessionId),
  };

  return {
    runtime,
    runCalls,
    release: () => {
      for (const resolve of parked.splice(0)) {
        resolve();
      }
    },
    setPending: (entries: PendingSeed[]) => {
      pending = entries;
    },
  };
}

// --------------------------- the harness ---------------------------

type HarnessOptions = {
  label: string;
  /** Overrides the recording sink; the throwing arm uses it. Notifications still record. */
  sink?: McpWriteNotifier;
};

type Harness = {
  /** The full-scope client. */
  call(name: string, args?: AnyRecord, which?: 'full' | 'readOnly'): Promise<ToolCall>;
  /** The write-tool names derived from `tools/list` (`readOnlyHint === false`). */
  listWriteTools(): Promise<string[]>;
  /** `tools/list` annotations, name → `readOnlyHint`. */
  annotationsByName(): Promise<Record<string, boolean | undefined>>;
  /** Every payload the recording sink saw. */
  notifications: McpWriteNotificationPayload[];
  clock: { value: number };
  control: ChatControlService;
  /** The full-scope bearer token string, so a leak can be asserted against. */
  tokenText: string;
  auditRows(): AuditRow[];
};

/** The write-tool call plan: one SUCCESSFUL call per write tool, with expected title. */
const WRITE_CALLS: Array<{ tool: string; args: AnyRecord; sessionTitle: string | null }> = [
  { tool: 'session_send', args: { session: SEND_SESSION, message: LONG_MESSAGE }, sessionTitle: SEND_TITLE },
  { tool: 'session_create', args: { project: PROJECT_ID }, sessionTitle: null },
  { tool: 'session_interrupt', args: { session: TARGET }, sessionTitle: TARGET_TITLE },
  { tool: 'session_start', args: { session: TARGET }, sessionTitle: TARGET_TITLE },
  { tool: 'session_close', args: { session: TARGET }, sessionTitle: TARGET_TITLE },
  { tool: 'session_cancel_queued', args: { session: TARGET, messageUuid: 'uuid-1' }, sessionTitle: TARGET_TITLE },
  {
    tool: 'session_reconfigure',
    args: { session: TARGET, model: 'claude-x', apiKey: ARG_SECRET },
    sessionTitle: TARGET_TITLE,
  },
  { tool: 'session_background', args: { session: TARGET }, sessionTitle: TARGET_TITLE },
  { tool: 'approval_answer', args: { requestId: REQUEST_ID, allow: true }, sessionTitle: null },
  // gap-mcp-ui-open-session: the sixth write tool. It notifies like every other
  // `readOnlyHint: false` tool, so the plan must carry it too — the plan's
  // deepEqual against the registry-derived set is the reading that forces a new
  // write tool to be called here.
  { tool: 'ui_open_session', args: { session: SEND_SESSION }, sessionTitle: SEND_TITLE },
  // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling `readOnlyHint:
  // false` navigation tools notify like every other write tool, so the plan must
  // carry them too — the plan's deepEqual against the registry-derived set is the
  // reading that forces each one to be called here.
  { tool: 'ui_focus_turn', args: { session: SEND_SESSION, turnId: 'anchor-1' }, sessionTitle: SEND_TITLE },
  { tool: 'ui_show_diff', args: { session: SEND_SESSION, filePath: 'src/app.ts' }, sessionTitle: SEND_TITLE },
  { tool: 'ui_open_task', args: { session: SEND_SESSION, taskId: 'QX-1' }, sessionTitle: SEND_TITLE },
];

async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const fixtureProject = path.join(tempDirectory, options.label);
  mkdirSync(fixtureProject, { recursive: true });

  let controlled: ReturnType<typeof createControlledRuntime> | undefined;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'mcp-write-notification.db');
    await initializeDatabase();
    getConnection()
      .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(USER_ONE, 'owner', 'hash');

    const seededAt = new Date(NOW).toISOString();
    for (const [id, name] of [
      [SEND_SESSION, SEND_TITLE],
      [WS_SESSION, WS_TITLE],
      [SCHED_SESSION, SCHED_TITLE],
      [TARGET, TARGET_TITLE],
    ] as const) {
      sessionsDb.createSession(id, 'claude', fixtureProject, name, seededAt, seededAt, null);
    }

    controlled = createControlledRuntime();
    controlled.setPending([
      {
        requestId: REQUEST_ID,
        sessionId: TARGET,
        toolName: 'Bash',
        input: { command: 'echo hi' },
        context: null,
        receivedAt: new Date(NOW),
      },
    ]);
    const control = createChatControlService({
      runtime: controlled.runtime as never,
      listApprovalSessionIds: () => [TARGET],
    });

    const clock = { value: 0 };
    const notifications: McpWriteNotificationPayload[] = [];
    const recordingSink: McpWriteNotifier = (payload) => {
      notifications.push(payload);
    };
    const writeNotifications = createMcpWriteNotification({
      sink: options.sink ?? recordingSink,
      now: () => clock.value,
      windowMs: 60_000,
      threshold: 5,
    });

    const tokens = createAccessTokensService({ now: () => new Date(NOW) });
    const fullToken = tokens.issueToken({
      userId: USER_ONE,
      name: FULL_TOKEN_NAME,
      scopes: [...ACCESS_TOKEN_SCOPES],
      expiresInDays: 30,
    });
    const readOnlyToken = tokens.issueToken({
      userId: USER_ONE,
      name: 'ac303-read',
      scopes: [ACCESS_TOKEN_SCOPES[0]],
      expiresInDays: 30,
    });
    if (!fullToken.ok || !readOnlyToken.ok) {
      throw new Error('the harness must mint both tokens');
    }

    const runGetDeps = {
      activity: { snapshot: () => null },
      sessions: { fetchHistory: async () => ({ messages: [], total: 0 }) },
      now: () => clock.value,
      sleep: async () => undefined,
      bootId: () => 'ac303-boot',
    };

    // gap-mcp-ui-open-session / gap-mcp-ui-focus-turn-show-diff-open-task: the
    // services the four `ui_*` navigation tools answer from. Exactly one browser
    // is connected, so each tool's optional `client` may be omitted and
    // auto-selected, and every navigation resolves `applied` at once — which is
    // all leg (a) needs: the call succeeds and therefore notifies. ONE bag, shared
    // by all four (their deps are the same shape), exactly as `server/index.ts`
    // binds one bag to all four.
    // Typed by the seam itself so the fake can never drift from the shape the
    // four navigation tools are wired with: the same bag is bound to all four.
    const uiNavDeps: UiNavigationToolDeps = {
      listUiClients: () => [
        {
          deviceId: 'dev-ac303',
          deviceName: 'AC303 Browser',
          tabs: [{ tabId: 'tab-ac303', deviceName: 'AC303 Browser', connectedAt: NOW }],
        },
      ],
      navigate: async (request) => ({
        navigationId: 'nav-ac303',
        deviceId: request.deviceId,
        deviceName: request.deviceName,
        tabId: 'tab-ac303',
        sessionId: request.sessionId,
        at: request.at,
        requestedBy: request.requestedBy,
        requestedAt: NOW,
        updatedAt: NOW,
        status: 'applied',
      }),
    };

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    mountMcpGateway(
      app,
      createMcpGatewayModule({
        env: { MCP_ENABLED: 'true' },
        tokens,
        control: control as never,
        selfTarget: {
          readTurn: () => ({ phase: 'idle', toolName: null, toolDurationMs: null }),
          writeToolNames: MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name),
        },
        writeTools: {
          runGet: { deps: runGetDeps, build: buildRunGet },
          sessionCreate: {
            projects: { list: () => [{ id: PROJECT_ID, title: 'AC303 project', path: fixtureProject }] },
            sessions: {
              create: () => ({ sessionId: CREATED_SESSION_ID }),
              switchLifecycle: () => undefined,
            },
            control: { send: async () => ({ ok: true, runId: 'unused', queued: false, queuedMessageUuid: null }) },
          } as never,
          sessionInterrupt: {
            control: { abort: async () => ({ ok: true, aborted: false }) },
          } as never,
          sessionHostControl: {
            hosts: {
              start: async (sessionId: string) => ({
                ok: true,
                hostId: 'host-1',
                sessionId,
                mode: 'resident',
                pid: 4242,
              }),
              close: (sessionId: string) => ({
                ok: true,
                hostId: 'host-1',
                sessionId,
                mode: 'resident',
                closeReason: 'user',
                leases: [],
              }),
              liveHost: () => null,
            },
          } as never,
          // gap-mcp-ui-open-session: `ui_open_session`'s services.
          uiOpenSession: uiNavDeps,
          // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling navigation
          // tools answer from the same bag.
          uiFocusTurn: uiNavDeps,
          uiShowDiff: uiNavDeps,
          uiOpenTask: uiNavDeps,
        },
        residentTools: {
          control: { cancelQueued: async () => 'withdrawn' },
          reconfigure: {
            sessions: { getSessionById: () => ({ provider: 'claude' }) },
            runtime: { reconfigure: async () => 'next-turn' },
            models: {
              setSessionModel: () => undefined,
              setSessionEffort: () => undefined,
              setSessionPermissionMode: () => undefined,
            },
            capabilities: {
              getProviderCapabilities: () => undefined,
              getRuntimeProviderCapabilities: () => undefined,
            },
          },
          background: {
            sessions: { getSessionById: () => ({ provider: 'claude' }) },
            hosts: { liveHostForSession: () => null },
            control: { stopTask: async () => 'requested' },
          },
          approvals: { control: control as never, now: () => NOW },
        } as never,
        writeNotifications,
      })
    );

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

    const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: nodeFetch,
      });
      const client = new Client({ name: 'ac303-criterion', version: '0.0.0' });
      await client.connect(transport);
      return { client, transport };
    };

    const full = await connect(fullToken.token.token);
    const readOnly = await connect(readOnlyToken.token.token);

    const callWith = async (which: 'full' | 'readOnly', name: string, args: AnyRecord): Promise<ToolCall> =>
      parseToolResult(
        await (which === 'full' ? full.client : readOnly.client).callTool({
          name,
          arguments: args,
        } as Parameters<Client['callTool']>[0]),
      );

    try {
      await run({
        call: (name, args = {}, which = 'full') => callWith(which, name, args),
        async listWriteTools() {
          const listed = await full.client.listTools();
          return listed.tools
            .filter((tool) => tool.annotations?.readOnlyHint === false)
            .map((tool) => tool.name)
            .sort();
        },
        async annotationsByName() {
          const listed = await full.client.listTools();
          const map: Record<string, boolean | undefined> = {};
          for (const tool of listed.tools) {
            map[tool.name] = tool.annotations?.readOnlyHint;
          }
          return map;
        },
        notifications,
        clock,
        control,
        tokenText: fullToken.token.token,
        auditRows() {
          return getConnection()
            .prepare('SELECT id, tool, outcome FROM mcp_audit_log ORDER BY id ASC')
            .all() as AuditRow[];
        },
      });
    } finally {
      await full.transport.close().catch(() => undefined);
      await readOnly.transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    controlled?.release();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --------------------------- (a) write calls notify once, safely ---------------------------

test('(a) every write tool from tools/list notifies once with the four facts and nothing else', { concurrency: false }, async () => {
  await withHarness({ label: 'a' }, async (harness) => {
    const writeTools = await harness.listWriteTools();
    const annotations = await harness.annotationsByName();
    say(`(a) writeTools=${JSON.stringify(writeTools)}`);
    assert.equal(annotations.approvals_list, true, 'approvals_list must be a read-only tool (its hint is true)');
    assert.ok(
      writeTools.includes('approvals_list') === false,
      'the write set is derived from readOnlyHint === false, so approvals_list is excluded'
    );

    // The plan MUST cover the registry-derived set; a new write tool reds here
    // until it is given a call, which is the "registry-driven" reading.
    const planned = WRITE_CALLS.map((call) => call.tool).sort();
    assert.deepEqual(
      planned,
      writeTools,
      `the call plan must cover exactly the derived write set (derived=${JSON.stringify(writeTools)})`
    );

    // Each call gets its own window: advance the fake clock past 60s between
    // calls so every one is the caller's first write inside its window.
    for (const plan of WRITE_CALLS) {
      const call = await harness.call(plan.tool, plan.args);
      say(`(a) ${plan.tool} ok=${!call.isError} text=${call.text.slice(0, 120)}`);
      assert.equal(call.isError, false, `${plan.tool} must succeed (text=${call.text})`);
      harness.clock.value += 61_000;
    }

    assert.equal(
      harness.notifications.length,
      WRITE_CALLS.length,
      `each write tool must notify exactly once (got ${JSON.stringify(harness.notifications)})`
    );

    for (const plan of WRITE_CALLS) {
      const matching = harness.notifications.filter((entry) => entry.tool === plan.tool);
      assert.equal(matching.length, 1, `${plan.tool} must notify exactly once`);
      const payload = matching[0];
      assert.equal(payload.count, 1, `${plan.tool}'s individual notification carries count 1`);
      assert.equal(payload.clientName, FULL_TOKEN_NAME, `${plan.tool}'s payload names the client`);
      assert.equal(payload.sessionTitle, plan.sessionTitle, `${plan.tool}'s payload carries the session title`);
      const expectedPreview = plan.tool === 'session_send' ? MESSAGE_HEAD : null;
      assert.equal(payload.messagePreview, expectedPreview, `${plan.tool}'s preview is the first 40 chars or null`);
    }

    const serialized = JSON.stringify(harness.notifications);
    assert.ok(serialized.includes(MESSAGE_HEAD), 'the 40-character head is present in the payload');
    assert.ok(
      serialized.includes(MESSAGE_TAIL) === false,
      'the 41st character onward must NOT appear in any payload field'
    );
    assert.ok(serialized.includes(ARG_SECRET) === false, 'an argument secret must NOT appear in any payload field');
    assert.ok(
      serialized.includes(harness.tokenText) === false,
      'the bearer token string must NOT appear in any payload field'
    );
  });
});

// --------------------------- (b) read / denied / error notify nobody ---------------------------

test('(b) a read-only ok, a denied write and an erroring write notify nobody and leave their own audit row', { concurrency: false }, async () => {
  await withHarness({ label: 'b' }, async (harness) => {
    // Read-only tool, succeeds.
    const readCall = await harness.call('approvals_list', { session: TARGET });
    say(`(b) approvals_list ok=${!readCall.isError} text=${readCall.text.slice(0, 120)}`);
    assert.equal(readCall.isError, false, 'approvals_list must succeed');

    // Write tool with a token missing its scope: denied before the handler.
    const deniedCall = await harness.call('session_send', { session: SEND_SESSION, message: 'nope' }, 'readOnly');
    say(`(b) session_send(readOnly) isError=${deniedCall.isError} text=${deniedCall.text}`);
    assert.equal(deniedCall.isError, true, 'a token missing the scope must be denied');

    // Write tool whose handler throws: unknown project.
    const errorCall = await harness.call('session_create', { project: 'no-such-project' });
    say(`(b) session_create(bad project) isError=${errorCall.isError} text=${errorCall.text.slice(0, 120)}`);
    assert.equal(errorCall.isError, true, 'an unknown project must raise an error result');

    assert.equal(
      harness.notifications.length,
      0,
      `a read-only, a denied and an erroring call must notify nobody (got ${JSON.stringify(harness.notifications)})`
    );

    const rows = harness.auditRows();
    say(`(b) auditRows=${JSON.stringify(rows)}`);
    const okRow = rows.find((row) => row.tool === 'approvals_list');
    const deniedRow = rows.find((row) => row.tool === 'session_send');
    const errorRow = rows.find((row) => row.tool === 'session_create');
    assert.equal(okRow?.outcome, 'ok', 'the read-only call leaves an ok row');
    assert.equal(deniedRow?.outcome, 'denied', 'the scope-denied call leaves a denied row');
    assert.equal(errorRow?.outcome, 'error', 'the throwing call leaves an error row');
  });
});

// --------------------------- (c) merge inside the window ---------------------------

test('(c) six writes inside one window collapse from five individuals to one summary', { concurrency: false }, async () => {
  await withHarness({ label: 'c' }, async (harness) => {
    for (let index = 0; index < 6; index += 1) {
      const call = await harness.call('session_interrupt', { session: TARGET });
      assert.equal(call.isError, false, `write ${index} must succeed`);
    }

    say(`(c) after 6 writes counts=${JSON.stringify(harness.notifications.map((entry) => entry.count))}`);
    assert.equal(harness.notifications.length, 6, 'five individuals plus one summary — never a sixth individual');
    for (let index = 0; index < 5; index += 1) {
      assert.equal(harness.notifications[index].count, 1, `notification ${index} is an individual (count 1)`);
    }
    assert.equal(harness.notifications[5].count, 6, 'the summary carries the cumulative window count');
    assert.equal(harness.notifications[5].tool, 'session_interrupt', 'the summary names the tool');

    // A further write in the SAME window stays silent (no 7th notification).
    await harness.call('session_interrupt', { session: TARGET });
    assert.equal(harness.notifications.length, 6, 'a further in-window write is silent');

    // Past the window, individual notifications resume.
    harness.clock.value += 61_000;
    await harness.call('session_interrupt', { session: TARGET });
    say(`(c) after window reset counts=${JSON.stringify(harness.notifications.map((entry) => entry.count))}`);
    assert.equal(harness.notifications.length, 7, 'the post-window write notifies');
    assert.equal(harness.notifications[6].count, 1, 'the post-window notification is an individual again');
  });
});

// --------------------------- (d) only the /mcp path notifies ---------------------------

test('(d) the shared control service is driven by websocket/scheduled without notifying; /mcp notifies', { concurrency: false }, async () => {
  await withHarness({ label: 'd' }, async (harness) => {
    const wsSend = await harness.control.send(
      { userId: USER_ONE, via: 'websocket' },
      { sessionId: WS_SESSION, content: 'hello over the socket' }
    );
    const scheduledSend = await harness.control.send(
      { userId: USER_ONE, via: 'scheduled' },
      { sessionId: SCHED_SESSION, content: 'hello from a timer' }
    );
    say(`(d) wsSend=${JSON.stringify(wsSend)} scheduledSend=${JSON.stringify(scheduledSend)}`);
    assert.ok(wsSend.ok, 'the WebSocket-path send must succeed');
    assert.ok(scheduledSend.ok, 'the scheduled-path send must succeed');
    assert.equal(
      harness.notifications.length,
      0,
      `the UI WebSocket and scheduled paths must NOT notify (got ${JSON.stringify(harness.notifications)})`
    );

    const mcpCall = await harness.call('session_send', { session: SEND_SESSION, message: 'hello over /mcp' });
    say(`(d) mcp session_send ok=${!mcpCall.isError}`);
    assert.equal(mcpCall.isError, false, 'the /mcp write must succeed');
    assert.equal(harness.notifications.length, 1, 'the /mcp write notifies once');
    assert.equal(harness.notifications[0].tool, 'session_send', 'the notification names the /mcp write tool');
  });
});

// --------------------------- (e) a throwing notifier cannot change the result ---------------------------

test('(e) a throwing notifier leaves the payload and the ok audit row identical', { concurrency: false }, async () => {
  const args = { session: TARGET };

  let cleanText = '';
  await withHarness({ label: 'e-clean' }, async (harness) => {
    const call = await harness.call('session_interrupt', args);
    assert.equal(call.isError, false, 'the clean arm must succeed');
    cleanText = call.text;
  });

  let thrownText = '';
  await withHarness(
    {
      label: 'e-throwing',
      sink: () => {
        throw new Error('the notifier exploded');
      },
    },
    async (harness) => {
      const call = await harness.call('session_interrupt', args);
      say(`(e) throwing arm isError=${call.isError} text=${call.text}`);
      assert.equal(call.isError, false, 'a throwing notifier must NOT turn the call into an error result');
      thrownText = call.text;
      const rows = harness.auditRows();
      const row = rows.find((entry) => entry.tool === 'session_interrupt');
      assert.equal(row?.outcome, 'ok', 'a throwing notifier must NOT turn the ok row into an error row');
    }
  );

  say(`(e) clean=${cleanText}`);
  assert.equal(thrownText, cleanText, 'the successful payload is byte-for-byte identical to the non-throwing arm');
});
