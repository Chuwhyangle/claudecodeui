/**
 * AC-286 criterion: a permission denial NAMES the scope the caller is missing —
 * identically wherever it is raised — and still writes a `denied` audit row that
 * carries that scope.
 *
 * Before this task a caller who was denied learned only that it was denied: the
 * audited wrapper's generic scope check answered the fixed sentence
 * "Insufficient scope for this tool." with no `code` and no `details`, and the
 * `session_background` stop branch raised a SECOND, differently-shaped refusal
 * (`SCOPE_DENIED`, with `session`/`taskId`) that the wrapper recorded as an
 * `error` rather than a denial. A caller could not tell WHICH scope to add, and
 * an operator could not read it back out of the audit log.
 *
 * Everything below is real: a real express application carries the production
 * `/mcp` mount behind the production token middleware, the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`, and the database is a
 * real better-sqlite3 file in a temp directory. The tool set is the production
 * one — the read, write and resident tables register every name they own — so
 * `tools/list` is the surface an external host would actually read. Only
 * `session_background`'s host snapshot is a stub, because the criterion drives a
 * stop through it and the surrounding session-hosts machinery is another task's
 * subject; the stop still goes through the SAME handler the production mount
 * installs.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random; this
 * is the same seam the sibling criteria use to avoid it.
 *
 * Readings, one leg each:
 *   (a) with a read-only token, EVERY higher-scope tool on `tools/list` answers
 *       `INSUFFICIENT_SCOPE` naming the scopes it is missing, and the probe set is
 *       derived (not hand-written): `tools/list` must be exactly the read-only
 *       names the module tables declare plus the higher-scope names they declare.
 *       The anti-idle reading: every read-only tool is NOT denied for scope, so
 *       "refuse everything" cannot pass this leg.
 *   (b) the `session_background` stop branch's refusal and the generic check's
 *       refusal are the SAME envelope field-for-field (`code`, `structuredContent`
 *       keys, `details` keys, `retryable`), and no non-test source under
 *       `server/modules/mcp-gateway/` still says `SCOPE_DENIED`.
 *   (c) both refusals write EXACTLY one audit row each, both `outcome: 'denied'`
 *       (the handler's must never be `error`), both carrying the missing scope as
 *       a JSON array in `denied_scopes`; a handler that throws a bare error still
 *       records `error`.
 *   (d) the positive control: a token holding the scope really stops the task
 *       (control service reached exactly once, `stopped: true`), and under a
 *       full-scope token no tool is denied for scope while at least one really
 *       succeeds.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb } from '@/modules/database/index.js';
import { ACCESS_TOKEN_SCOPES, createAccessTokensService } from '@/modules/oauth/index.js';
import type { HostLease } from '@/shared/types.js';

import type { McpReadToolDeps, McpWriteToolDeps } from '../index.js';

const {
  MCP_GATEWAY_PATH,
  MCP_STAGE3_READ_TOOLS,
  MCP_STAGE4_WRITE_TOOLS,
  MCP_STAGE6_RESIDENT_TOOLS,
  createMcpAuthMiddleware,
  mountMcpGateway,
} = await import('../index.js');

// --------------------------- scope vocabulary ---------------------------

// AC-243's single scope vocabulary, read positionally (its order is pinned by the
// OAuth module's own criterion); the literals are never re-typed here.
const [
  READ_SCOPE,
  SESSION_SEND_SCOPE,
  SESSION_CREATE_SCOPE,
  SESSION_CONTROL_SCOPE,
  APPROVE_SCOPE,
  NAVIGATE_SCOPE,
] = ACCESS_TOKEN_SCOPES;

/** The only scope the read-only token carries — the "held" set the missing set is measured against. */
const READ_ONLY_TOKEN_SCOPES: string[] = [READ_SCOPE];

const USER_ONE = 1;

/** The session the background stub holds; the stop branch resolves it before any scope read. */
const SESSION_ID = 'sess-warm';
/** Two holdable background tasks: one for the control token, one for the full-scope token. */
const BG_IDS = ['bg-1', 'bg-2'] as const;
const CRON_ID = 'cron-1';

// --------------------------- the declared tool set ---------------------------

/**
 * Every tool name the module tables declare, mapped to the scope it requires.
 *
 * The three tool families are the single source of truth the transport itself
 * reads; the four names that register ALONGSIDE a table (because AC-271's
 * criterion pins `MCP_STAGE6_RESIDENT_TOOLS` to exactly `['session_cancel_queued']`)
 * are stated here with the scope their own registration function installs. The
 * criterion never compares against a prose list: `tools/list` is checked against
 * THIS map, so a tool that registers without a scope declaration makes leg (a)
 * red rather than silently escaping the probe.
 */
function declaredToolScopes(): Map<string, string> {
  const scopes = new Map<string, string>();
  for (const tool of MCP_STAGE3_READ_TOOLS) {
    scopes.set(tool.name, tool.requiredScope);
  }
  for (const tool of MCP_STAGE4_WRITE_TOOLS) {
    scopes.set(tool.name, tool.requiredScope);
  }
  for (const tool of MCP_STAGE6_RESIDENT_TOOLS) {
    scopes.set(tool.name, tool.scope);
  }
  scopes.set('session_reconfigure', SESSION_CONTROL_SCOPE);
  scopes.set('session_background', READ_SCOPE);
  scopes.set('approvals_list', READ_SCOPE);
  scopes.set('approval_answer', APPROVE_SCOPE);
  // gap-mcp-ui-open-session: registered alongside the stage-4 table, so it is
  // not covered by the loop above.
  scopes.set('ui_open_session', NAVIGATE_SCOPE);
  // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling navigation tools,
  // registered the same way and each requiring the same `cloudcli:navigate` scope.
  scopes.set('ui_focus_turn', NAVIGATE_SCOPE);
  scopes.set('ui_show_diff', NAVIGATE_SCOPE);
  scopes.set('ui_open_task', NAVIGATE_SCOPE);
  return scopes;
}

/** The tools a token holding `cloudcli:read` alone may call. */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MCP_STAGE3_READ_TOOLS.map((tool) => tool.name),
  'approvals_list',
  'session_background',
]);

/** The tools requiring more than `cloudcli:read`, with the scope each declares. */
function higherScopeTools(): Map<string, string> {
  const higher = new Map<string, string>();
  for (const [name, scope] of declaredToolScopes()) {
    if (!READ_ONLY_TOOL_NAMES.has(name)) {
      higher.set(name, scope);
    }
  }
  return higher;
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

// --------------------------- tool-call reading ---------------------------

/** What a scope refusal reads back as, projected from the wire result. */
type ScopeRefusal = {
  name: string;
  isError: boolean;
  code: unknown;
  message: string;
  retryable: unknown;
  /** `structuredContent.details` when present, else null. */
  details: Record<string, unknown> | null;
  /** `content[0].text` — the human sentence the refusal spells out. */
  text: string;
  /** The full `structuredContent`, for the field-for-field comparison in leg (b). */
  structuredContent: Record<string, unknown> | null;
};

/** Projects a raw `callTool` result into the reading legs assert over. */
function readRefusal(name: string, result: unknown): ScopeRefusal {
  const call = result as { isError?: boolean; content?: unknown; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks
    .map((block) => (block as { type?: string; text?: string }).text ?? '')
    .join('');
  const structured =
    typeof call.structuredContent === 'object' && call.structuredContent !== null
      ? (call.structuredContent as Record<string, unknown>)
      : null;
  const details =
    structured !== null && typeof structured.details === 'object' && structured.details !== null
      ? (structured.details as Record<string, unknown>)
      : null;
  return {
    name,
    isError: call.isError === true,
    code: structured?.code,
    message: typeof structured?.message === 'string' ? structured.message : text,
    retryable: structured?.retryable,
    details,
    text,
    structuredContent: structured,
  };
}

/** The `requiredScopes` array a refusal carries, or a failed assertion when it is not a string array. */
function requiredScopesOf(refusal: ScopeRefusal): string[] {
  const raw = refusal.details?.requiredScopes;
  assert.ok(Array.isArray(raw), `${refusal.name}: details.requiredScopes must be an array, got ${JSON.stringify(raw)}`);
  for (const scope of raw as unknown[]) {
    assert.equal(typeof scope, 'string', `${refusal.name}: every requiredScopes entry must be a string`);
  }
  return raw as string[];
}

/** The arguments a probe sends: only `session_background` has a meaningful read-only form. */
function probeArgs(name: string): Record<string, unknown> {
  if (name === 'session_background') {
    return { session: SESSION_ID };
  }
  return {};
}

// --------------------------- the background stub ---------------------------

/**
 * `session_background`'s injected services over a mutable in-memory lease table.
 *
 * `liveHostForSession` answers the snapshot the tool reads; `stopTask` records
 * the caller and input, removes the lease (the transition the driver would make),
 * and answers `requested` — so a stop that reaches the control service is a real
 * success and a stop that is refused never arrives at all. This is the one part
 * of the harness that is not the production object graph, and it is deliberately
 * small: the criterion is about the scope check in front of the control service,
 * not about the session-hosts machinery behind it.
 */
function createBackgroundStub() {
  const leases = new Map<string, HostLease[]>([
    [
      SESSION_ID,
      [
        { kind: 'background-task', id: BG_IDS[0] },
        { kind: 'background-task', id: BG_IDS[1] },
        { kind: 'cron', id: CRON_ID, recurring: true, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 },
      ],
    ],
  ]);
  const stopTaskCalls: Array<{ caller: unknown; input: { sessionId: string; taskId: string } }> = [];

  return {
    stopTaskCalls,
    sessions: {
      getSessionById: (sessionId: string) => (leases.has(sessionId) ? { provider: 'claude' } : null),
    },
    hosts: {
      liveHostForSession: (sessionId: string) => {
        const held = leases.get(sessionId);
        if (!held) {
          return null;
        }
        return { state: 'running', pid: 4242, bindings: new Map([[sessionId, { leases: held }]]) };
      },
    },
    control: {
      stopTask: async (caller: unknown, input: { sessionId: string; taskId: string }) => {
        stopTaskCalls.push({ caller, input });
        const held = leases.get(input.sessionId) ?? [];
        const index = held.findIndex(
          (lease) => (lease.kind === 'background-task' || lease.kind === 'cron') && lease.id === input.taskId,
        );
        if (index >= 0) {
          held.splice(index, 1);
        }
        return 'requested' as const;
      },
    },
  };
}

// --------------------------- harness ---------------------------

type Harness = {
  baseUrl: string;
  /** Mints a live token with the given scopes. */
  issue: (scopes: string[]) => { id: number; token: string };
  /** Calls `tool` through a real SDK client authenticated with `token`. */
  call: (token: string, tool: string, args?: Record<string, unknown>) => Promise<ScopeRefusal>;
  /** `tools/list`, as the SDK client reads it. */
  listTools: (token: string) => Promise<string[]>;
  background: ReturnType<typeof createBackgroundStub>;
};

/**
 * Boots one arm: a fresh temp database, the real token service, and the
 * production `/mcp` mount carrying all three tool families over the background
 * stub. Returns the seams a leg drives.
 */
async function withGateway(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-insufficient-scope-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'insufficient-scope.db');
  await initializeDatabase();
  // `access_tokens.user_id` references `users(id)`, so the owner row has to exist.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const tokens = createAccessTokensService({ now: () => new Date() });
  const background = createBackgroundStub();

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    // The production tool families. The read/write bags are empty on purpose:
    // every tool they install is denied for scope before its handler runs, so an
    // empty bag cannot change the reading (and the one handler a leg DOES reach —
    // `session_background` — gets its real stub below).
    readTools: {} as McpReadToolDeps,
    writeTools: {} as McpWriteToolDeps,
    residentTools: {
      control: background.control as never,
      background: {
        sessions: background.sessions,
        hosts: background.hosts,
        control: background.control,
      },
      reconfigure: {} as never,
      approvals: {} as never,
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  // Why TWO clients per token. The SDK `Client` validates a result's
  // `structuredContent` against the tool's declared `outputSchema` — and it does
  // so even when `isError` is true. Output validators are cached only when
  // `client.listTools()` runs, so the listing client would THROW `-32602
  // Structured content does not match the tool's output schema` on the very
  // error envelopes this criterion reads. Every tool CALL therefore runs on a
  // client whose validator cache stays cold (it never lists); both clients reach
  // the SAME stateless mount, so the name set one reads is the set the other
  // calls. This is the seam AC-288's criterion documents.
  const connect = async (token: string, forListing: boolean): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: forListing ? 'ac286-list' : 'ac286-call', version: '0.0.0' });
    await client.connect(transport);
    (forListing ? listingClients : callClients).set(token, client);
    clients.add(client);
    return client;
  };
  const listingClients = new Map<string, Client>();
  const callClients = new Map<string, Client>();
  const clients = new Set<Client>();

  const issue = (scopes: string[]): { id: number; token: string } => {
    const issued = tokens.issueToken({ userId: USER_ONE, name: 'ac286', scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error('the harness issued a token with a lifetime the service rejects');
    }
    return { id: issued.token.id, token: issued.token.token };
  };

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      issue,
      background,
      listTools: async (token) => {
        const client = listingClients.get(token) ?? (await connect(token, true));
        const listed = await client.listTools();
        return listed.tools.map((tool) => tool.name);
      },
      call: async (token, tool, args = {}) => {
        const client = callClients.get(token) ?? (await connect(token, false));
        const result = await client.callTool({
          name: tool,
          arguments: args,
        } as Parameters<Client['callTool']>[0]);
        return readRefusal(tool, result);
      },
    });
  } finally {
    for (const client of clients) {
      await client.close().catch(() => undefined);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The most recently written audit row, or a failed assertion when the log is empty. */
function lastAuditRow(): ReturnType<typeof mcpAuditLogDb.allRows>[number] {
  const rows = mcpAuditLogDb.allRows();
  assert.ok(rows.length > 0, 'expected at least one audit row');
  return rows[rows.length - 1];
}

// --------------------------- (a) the generic check names every missing scope ---------------------------

test('(a) every higher-scope tool refuses a read-only token with the missing scopes named', async () => {
  await withGateway(async (harness) => {
    const readOnly = harness.issue(READ_ONLY_TOKEN_SCOPES);
    const listed = (await harness.listTools(readOnly.token)).sort();

    // The probe set is DERIVED: `tools/list` is exactly the read-only names the
    // module tables declare plus the higher-scope names they declare. A tool that
    // registers without a scope declaration lands in neither half and reds this.
    const declared = declaredToolScopes();
    const expected = [...new Set([...READ_ONLY_TOOL_NAMES, ...higherScopeTools().keys()])].sort();
    assert.deepEqual(listed, expected, 'tools/list must be exactly the declared read-only + higher-scope tools');
    for (const name of listed) {
      assert.ok(declared.has(name), `${name} is listed but declares no scope in the module tables`);
    }

    const higher = higherScopeTools();
    const coverage: string[] = [];
    for (const [name, declaredScope] of higher) {
      const refusal = await harness.call(readOnly.token, name, probeArgs(name));

      assert.equal(refusal.isError, true, `${name} must be refused for a read-only token`);
      assert.equal(refusal.code, 'INSUFFICIENT_SCOPE', `${name} must be refused with INSUFFICIENT_SCOPE`);
      assert.equal(typeof refusal.retryable, 'boolean', `${name}: retryable must be an explicit boolean`);

      const missing = requiredScopesOf(refusal);
      assert.ok(missing.length > 0, `${name}: the missing-scope set must be non-empty`);
      for (const scope of missing) {
        assert.ok(
          (ACCESS_TOKEN_SCOPES as readonly string[]).includes(scope),
          `${name}: requiredScopes entry "${scope}" is not part of the scope vocabulary`,
        );
        assert.ok(
          !READ_ONLY_TOKEN_SCOPES.includes(scope),
          `${name}: requiredScopes must name only MISSING scopes, not held ones`,
        );
      }
      assert.ok(
        missing.includes(declaredScope),
        `${name}: requiredScopes ${JSON.stringify(missing)} must include the tool's declared scope "${declaredScope}"`,
      );

      for (const scope of missing) {
        assert.ok(refusal.message.includes(scope), `${name}: the message must name "${scope}" verbatim`);
      }
      assert.match(refusal.message, /re-?authoriz|重新授权/i, `${name}: the message must say how to fix it`);

      // The pre-AC-286 fixed sentence must be gone from every refusal.
      assert.notEqual(refusal.text, 'Insufficient scope for this tool.', `${name}: the old fixed sentence must be gone`);

      coverage.push(`${name}: requiredScopes=[${missing.join(',')}]`);
    }

    // Anti-idle: a read-only tool is NOT denied for scope, so "refuse everything"
    // cannot pass this leg.
    const idle: string[] = [];
    for (const name of READ_ONLY_TOOL_NAMES) {
      const reading = await harness.call(readOnly.token, name, probeArgs(name));
      assert.notEqual(
        reading.code,
        'INSUFFICIENT_SCOPE',
        `${name} is a read-only tool and must not be refused for scope with a read-only token`,
      );
      idle.push(`${name}: code=${String(reading.code)} isError=${reading.isError}`);
    }

    console.log(`(a) higher-scope tool coverage (${coverage.length}): ${coverage.join(' | ')}`);
    console.log(`(a) read-only anti-idle (${idle.length}): ${idle.join(' | ')}`);
  });
});

// --------------------------- (b) both checks render the same envelope ---------------------------

test('(b) the handler-internal refusal is the same envelope as the generic one', async () => {
  await withGateway(async (harness) => {
    const readOnly = harness.issue(READ_ONLY_TOKEN_SCOPES);

    // Generic check: `session_send` is denied by the audited wrapper before its
    // handler is reached.
    const generic = await harness.call(readOnly.token, 'session_send', { session: SESSION_ID, message: 'x' });
    // Handler-internal check: `session_background`'s stop branch throws.
    const handler = await harness.call(readOnly.token, 'session_background', {
      session: SESSION_ID,
      stopTaskId: BG_IDS[0],
    });

    assert.equal(generic.code, 'INSUFFICIENT_SCOPE', 'the generic refusal must be INSUFFICIENT_SCOPE');
    assert.equal(handler.code, 'INSUFFICIENT_SCOPE', 'the handler refusal must be INSUFFICIENT_SCOPE');
    assert.equal(handler.code, generic.code, 'both refusals must carry the same code');
    assert.equal(handler.retryable, generic.retryable, 'both refusals must carry the same retryable value');
    assert.deepEqual(
      Object.keys(handler.structuredContent ?? {}).sort(),
      Object.keys(generic.structuredContent ?? {}).sort(),
      'both refusals must expose the same structuredContent keys',
    );
    assert.deepEqual(
      Object.keys(handler.details ?? {}).sort(),
      Object.keys(generic.details ?? {}).sort(),
      'both refusals must expose the same details keys',
    );
    assert.deepEqual(Object.keys(handler.details ?? {}), ['requiredScopes'], 'details must be exactly { requiredScopes }');
    // The scope the handler owns, named — and NOT the session/taskId context of
    // the tool's other refusals.
    assert.deepEqual(requiredScopesOf(handler), [SESSION_CONTROL_SCOPE], 'the stop refusal names the control scope');

    // The second permission-denial code is gone from the production sources.
    const moduleDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    for (const entry of readdirSync(moduleDirectory)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) {
        continue;
      }
      if (readFileSync(path.join(moduleDirectory, entry), 'utf8').includes('SCOPE_DENIED')) {
        offenders.push(entry);
      }
    }
    assert.deepEqual(offenders, [], 'no production mcp-gateway source may still say SCOPE_DENIED');

    console.log(`(b) generic  = ${JSON.stringify(generic.structuredContent)}`);
    console.log(`(b) handler  = ${JSON.stringify(handler.structuredContent)}`);
    console.log(`(b) SCOPE_DENIED offenders = [${offenders.join(',')}]`);
  });
});

// --------------------------- (c) a denial still writes a denied row with the scope ---------------------------

test('(c) both refusals write exactly one denied audit row carrying the missing scope', async () => {
  await withGateway(async (harness) => {
    const readOnly = harness.issue(READ_ONLY_TOKEN_SCOPES);
    const full = harness.issue([...ACCESS_TOKEN_SCOPES]);
    const authorization = readOnly.token;

    // Generic check.
    const beforeGeneric = mcpAuditLogDb.count();
    await harness.call(authorization, 'session_send', { session: SESSION_ID, message: 'x' });
    assert.equal(mcpAuditLogDb.count(), beforeGeneric + 1, 'a generic denial must write exactly one row');
    const genericRow = lastAuditRow();
    assert.equal(genericRow.tool, 'session_send');
    assert.equal(genericRow.outcome, 'denied', 'the generic denial must be recorded as denied');
    assert.deepEqual(JSON.parse(genericRow.denied_scopes ?? 'null'), [SESSION_SEND_SCOPE], 'the generic row names the missing scope');

    // Handler-internal check — must be `denied`, never `error`.
    const beforeHandler = mcpAuditLogDb.count();
    await harness.call(authorization, 'session_background', { session: SESSION_ID, stopTaskId: BG_IDS[0] });
    assert.equal(mcpAuditLogDb.count(), beforeHandler + 1, 'a handler denial must write exactly one row');
    const handlerRow = lastAuditRow();
    assert.equal(handlerRow.tool, 'session_background');
    assert.equal(handlerRow.outcome, 'denied', 'the handler-internal denial must NOT be recorded as error');
    assert.deepEqual(
      JSON.parse(handlerRow.denied_scopes ?? 'null'),
      [SESSION_CONTROL_SCOPE],
      'the handler row names the missing scope',
    );

    // Positive control: a handler that throws a bare (non-scope) error is still
    // recorded as `error`, with no scope reading. `sessions_list` reaches its
    // handler under a full-scope token and throws on the empty read bag.
    const beforeError = mcpAuditLogDb.count();
    const bare = await harness.call(full.token, 'sessions_list', {});
    assert.equal(bare.isError, true, 'the bare-throwing handler must answer isError');
    assert.notEqual(bare.code, 'INSUFFICIENT_SCOPE', 'a non-scope throw must not be mislabelled a scope denial');
    assert.equal(mcpAuditLogDb.count(), beforeError + 1, 'the bare throw must write exactly one row');
    const errorRow = lastAuditRow();
    assert.equal(errorRow.tool, 'sessions_list');
    assert.equal(errorRow.outcome, 'error', 'a bare handler throw must still be recorded as error');
    assert.equal(errorRow.denied_scopes, null, 'a non-scope error carries no denied scopes');

    console.log(`(c) generic  row = ${JSON.stringify(genericRow)}`);
    console.log(`(c) handler  row = ${JSON.stringify(handlerRow)}`);
    console.log(`(c) error    row = ${JSON.stringify(errorRow)}`);
  });
});

// --------------------------- (d) the positive control: a permitted caller really acts ---------------------------

test('(d) a permitted token really stops the task and no tool is scope-denied', async () => {
  await withGateway(async (harness) => {
    const control = harness.issue([READ_SCOPE, SESSION_CONTROL_SCOPE]);
    const full = harness.issue([...ACCESS_TOKEN_SCOPES]);

    // The control token's stop really happens: the control service is reached
    // exactly once and the handler reports the stop.
    const stopped = await harness.call(control.token, 'session_background', {
      session: SESSION_ID,
      stopTaskId: BG_IDS[0],
    });
    assert.equal(stopped.isError, false, 'a token holding the control scope must be allowed to stop');
    assert.equal(stopped.details, null, 'a success carries no error details');
    // AC5's own field: the payload really reports the stop, and names what it
    // stopped — `isError: false` alone would also hold for a listing response.
    assert.equal(stopped.structuredContent?.stopped, true, 'the success payload must report stopped: true');
    assert.equal(stopped.structuredContent?.taskId, BG_IDS[0], 'the success payload must name the stopped task');
    assert.equal(harness.background.stopTaskCalls.length, 1, 'the control service must be reached exactly once');
    assert.deepEqual(harness.background.stopTaskCalls[0].input, { sessionId: SESSION_ID, taskId: BG_IDS[0] });

    // Under a full-scope token no tool is denied for scope, and at least one
    // really succeeds (the second stop, plus the read-only listing).
    const secondStop = await harness.call(full.token, 'session_background', {
      session: SESSION_ID,
      stopTaskId: BG_IDS[1],
    });
    assert.equal(secondStop.isError, false, 'the full-scope token must be allowed to stop as well');
    assert.equal(harness.background.stopTaskCalls.length, 2, 'the second stop must reach the control service');

    const listed = await harness.listTools(full.token);
    const denials: string[] = [];
    let successes = 0;
    for (const name of listed) {
      const reading = await harness.call(full.token, name, probeArgs(name));
      assert.notEqual(
        reading.code,
        'INSUFFICIENT_SCOPE',
        `${name} must not be denied for scope under a token holding every scope`,
      );
      if (!reading.isError) {
        successes += 1;
      }
      denials.push(`${name}: code=${String(reading.code)} isError=${reading.isError}`);
    }
    assert.ok(successes >= 1, 'at least one tool must really succeed under a full-scope token');

    console.log(
      `(d) stop count=${harness.background.stopTaskCalls.length} secondStop.isError=${secondStop.isError} successes=${successes}`,
    );
    console.log(`(d) per-tool: ${denials.join(' | ')}`);
  });
});
