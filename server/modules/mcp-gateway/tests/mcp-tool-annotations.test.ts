/**
 * AC1–AC7 criterion: every tool the gateway registers on `tools/list` carries
 * the annotations the one table declares — and no write tool is mislabelled
 * read-only.
 *
 * The reading is taken through the PRODUCTION mount: a real express application
 * carries the `/mcp` endpoint behind an authorize seam that hands every request
 * a principal, the MCP SDK's own `Client` speaks to it over
 * `StreamableHTTPClientTransport`, and the annotations are read back off
 * `tools/list` exactly as a host (ChatGPT's custom-MCP developer mode, Claude
 * Code, …) would read them.
 *
 * Only `tools/list` is driven, so no tool handler ever runs and none of the
 * injected deps bags has a method called: the bags below exist so
 * `registerMcpReadTools` / `registerMcpWriteTools` / `registerMcpResidentTools`
 * install every name their tables own. That is the point — the criterion is about
 * the DECLARATION surface, not the behaviour a handler would produce, and using
 * empty bags keeps the fixture honest about that. The one backing store the file
 * needs is a migrated temp database, because leg (f) drives a real refusal
 * through the audited wrapper, which writes the denial to `mcp_audit_log`.
 *
 * Readings, one leg each:
 *   (a) `tools/list` is exactly the keys of `MCP_TOOL_ANNOTATIONS` — completeness
 *       in both directions, no unannotated tool and no phantom row;
 *   (b) every listed tool's annotations deep-equal the table, and deep-equal what
 *       `readMcpToolAnnotations` answers for the same name;
 *   (c) the read-only set is exactly the seven stage-3 read tools plus
 *       `approvals_list` and `draft_get`, and every write/control tool is NOT
 *       marked read-only (AC2/AC3 — the mislabel this task exists to prevent);
 *   (d) `session_interrupt` / `session_close` / `session_cancel_queued` /
 *       `session_background` / `draft_set` are destructive, while `session_send` /
 *       `session_create` / `session_reconfigure` / `draft_submit` are not (AC3/AC4);
 *   (e) the reader throws on a name the table does not own, so a future tool
 *       cannot register unannotated by omission (AC1).
 *   (f) a token that lacks a tool's scope is still refused WITH the annotations
 *       on the tool — the declarations are metadata only and enforce nothing
 *       (AC6).
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random; this
 * is the same seam the sibling criteria use to avoid it.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  McpGatewayToolName,
  McpReadToolDeps,
  McpResidentToolDeps,
  McpWriteToolDeps,
} from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-tool-annotations-test-secret';
delete process.env.VITE_IS_PLATFORM;

// Leg (f) drives a real call through the audited wrapper, which writes one
// `mcp_audit_log` row per denial (AC-286 adds the `denied_scopes` column that row
// carries). A file that writes audit rows needs a database with the CURRENT
// schema, so give it its own migrated temp DB rather than riding the ambient
// `DATABASE_PATH` — the ambient file is a developer's real DB, and one that
// predates a migration reds the insert with a bare "no such column".
const annotationsDbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-tool-annotations-'));
process.env.DATABASE_PATH = path.join(annotationsDbDirectory, 'annotations.db');
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
await initializeDatabase();
after(() => {
  closeConnection();
  rmSync(annotationsDbDirectory, { recursive: true, force: true });
});

const {
  MCP_GATEWAY_PATH,
  MCP_STAGE3_READ_TOOLS,
  MCP_STAGE4_WRITE_TOOLS,
  MCP_STAGE6_RESIDENT_TOOLS,
  MCP_TOOL_ANNOTATIONS,
  mountMcpGateway,
  readMcpToolAnnotations,
} = await import('../index.js');

/** The principal the authorize seam attaches to every request. */
const PRINCIPAL = { userId: 1, tokenId: 1, clientId: null, scopes: ['cloudcli:read'] };

/** Every request carries a principal, so the audited seam admits it. */
const authorizeWithPrincipal: RequestHandler = (_req, res, next) => {
  res.locals.mcpPrincipal = PRINCIPAL;
  next();
};

/**
 * The deps bags whose presence makes each of the three tables register its full
 * name set. The handlers are never reached by `tools/list`, so the bags are
 * deliberately empty; the resident bag's three optional members are present so
 * `session_reconfigure` / `session_background` / `approvals_list` /
 * `approval_answer` register alongside the frozen `MCP_STAGE6_RESIDENT_TOOLS`,
 * and the draft store member (gap-mcp-draft-get-set-submit) is present so
 * `draft_get` / `draft_set` / `draft_submit` register alongside their tables and
 * the listed name set stays exactly the annotation table's keys — no handler of
 * theirs is ever entered by a `tools/list` reading.
 */
const readTools = { draft: {} } as unknown as McpReadToolDeps;
const writeTools = { draft: {} } as unknown as McpWriteToolDeps;
const residentTools = { reconfigure: {}, background: {}, approvals: {} } as unknown as McpResidentToolDeps;

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

// --------------------------- the mount ---------------------------

/** What `client.listTools()` answers, so the helper can return it without restating the SDK shape. */
type ListedTools = Awaited<ReturnType<Client['listTools']>>;

/**
 * Mounts the production `/mcp` endpoint with all three tool families and runs
 * `run` against a connected SDK client.
 */
async function withGateway(run: (client: Client) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: authorizeWithPrincipal,
    readTools,
    writeTools,
    residentTools,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`),
    { fetch: nodeFetch },
  );
  const client = new Client({ name: 'ac1-annotations-criterion', version: '0.0.0' });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Lists the mounted gateway's tools. */
async function listRegisteredTools(): Promise<ListedTools> {
  let listed: ListedTools | undefined;
  await withGateway(async (client) => {
    listed = await client.listTools();
  });
  return listed as ListedTools;
}

// --------------------------- criteria ---------------------------

test('(a)(b) tools/list carries exactly the annotated table, annotations verbatim', async () => {
  const listed = await listRegisteredTools();

  const listedNames = listed.tools.map((tool) => tool.name).sort();
  const expectedNames = Object.keys(MCP_TOOL_ANNOTATIONS).sort();
  assert.deepEqual(listedNames, expectedNames, 'tools/list must be exactly the names the annotation table owns');

  for (const tool of listed.tools) {
    const expected = MCP_TOOL_ANNOTATIONS[tool.name as McpGatewayToolName];
    assert.deepEqual(tool.annotations, expected, `${tool.name} must declare its table annotations verbatim`);
    assert.deepEqual(
      tool.annotations,
      readMcpToolAnnotations(tool.name),
      `${tool.name}: the reader must answer the same annotations the wire carries`,
    );
    // Every hint is stated, so an absent hint cannot fall back to the
    // write-leaning spec default (destructiveHint: true, openWorldHint: true).
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(
        typeof (tool.annotations as Record<string, unknown>)[hint],
        'boolean',
        `${tool.name}.${hint} must be an explicit boolean`,
      );
    }
  }
});

test('(c) the read-only set is the seven read tools plus approvals_list and draft_get; no write tool is read-only', async () => {
  const listed = await listRegisteredTools();
  const readOnly = listed.tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name).sort();

  const readToolNames = MCP_STAGE3_READ_TOOLS.map((tool) => tool.name);
  // `draft_get` joins the read-only set without being a frozen `MCP_STAGE3_READ_TOOLS`
  // name: its `cloudcli:read` scope is a permission fact, not a table membership
  // (gap-mcp-draft-get-set-submit), exactly as `approvals_list` reads with a read
  // scope while living in the resident table.
  const expectedReadOnly = [...readToolNames, 'approvals_list', 'draft_get'].sort();
  assert.deepEqual(readOnly, expectedReadOnly, 'exactly the read tools, approvals_list and draft_get may be read-only');

  const writes = [
    ...MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name),
    ...MCP_STAGE6_RESIDENT_TOOLS.map((tool) => tool.name),
    'session_reconfigure',
    'session_background',
    'approval_answer',
    'draft_set',
    'draft_submit',
  ];
  for (const name of writes) {
    assert.equal(
      listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint,
      false,
      `${name} is a write/control tool and must NOT be marked read-only`,
    );
  }
});

test('(d) destructive tools are marked destructive, additive writes are not', async () => {
  const listed = await listRegisteredTools();
  const destructive = (name: string): boolean | undefined =>
    listed.tools.find((tool) => tool.name === name)?.annotations?.destructiveHint;

  for (const name of ['session_interrupt', 'session_close', 'session_cancel_queued', 'session_background', 'draft_set']) {
    assert.equal(destructive(name), true, `${name} terminates/discards held work and must be destructive`);
  }
  for (const name of ['session_send', 'session_create', 'session_reconfigure', 'approval_answer', 'draft_submit']) {
    assert.equal(destructive(name), false, `${name} is additive and must not claim to be destructive`);
  }
});

test('(e) the reader throws on a name the table does not own', () => {
  assert.throws(
    () => readMcpToolAnnotations('not_a_gateway_tool'),
    /no mcp tool annotations are declared/i,
    'an unannotated name must fail loudly at mount time, never answer undefined',
  );
});

test('(f) AC6: the annotations are metadata only — the scope check still refuses a call', async () => {
  // The principal carries `cloudcli:read` alone. `session_send` advertises
  // `readOnlyHint: false` / `openWorldHint: true` on `tools/list`, and that
  // declaration must not be read as a grant: the audited wrapper still denies the
  // call for the missing scope, exactly as it did before any annotations existed.
  await withGateway(async (client) => {
    const reading = await client.callTool({ name: 'session_send', arguments: { session: 'x', message: 'y' } });
    assert.equal(reading.isError, true, 'a token without cloudcli:session:send must still be refused');
    // AC-286: the refusal names the scope the caller is missing, in the machine
    // field AND in the sentence — the old fixed "Insufficient scope for this
    // tool." text no longer carries the reading.
    const envelope = reading.structuredContent as
      | { code?: unknown; message?: unknown; details?: { requiredScopes?: unknown } }
      | undefined;
    assert.equal(envelope?.code, 'INSUFFICIENT_SCOPE', 'the refusal must be the audited wrapper scope check');
    assert.deepEqual(
      envelope?.details?.requiredScopes,
      ['cloudcli:session:send'],
      'the refusal must name the scope the caller is missing',
    );
    const text = (reading.content as Array<{ type: string; text?: string }>)
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('');
    assert.match(text, /cloudcli:session:send/, 'the sentence must name the missing scope');
    assert.doesNotMatch(text, /^Insufficient scope for this tool\.$/, 'the pre-AC-286 fixed sentence must be gone');
  });
});
