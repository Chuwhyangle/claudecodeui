/**
 * AC-246 criterion: a caller's project/session reference resolves to exactly one
 * id, or the call is refused with the candidates — and an unclear target performs
 * no write at all.
 *
 * Everything below is real. The resolver runs against entries read from a real
 * better-sqlite3 database through the production active listings
 * (`getProjectsWithSessions` and `sessionsService.listRecentSessions`); the
 * archived rows that must NOT take part are real rows archived through the
 * repository (`updateProjectIsArchivedById` / `updateSessionIsArchived`), and the
 * archived listings are read back to prove the fixture archived something rather
 * than that the query merely missed. The write-path reading is driven through the
 * production `/mcp` mount with the MCP SDK's own `Client`: the three write-shaped
 * tools register through the SAME audited seam AC-245+'s tools use, and their
 * bodies increment the two service spies a real write tool would call.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240's criterion documents the same hazard), and the SDK's
 * `StreamableHTTPClientTransportOptions.fetch` is the seam that avoids it without
 * giving up the SDK client.
 *
 * Readings, one leg each:
 *   (a) a title substring matches case-insensitively and resolves to one id;
 *   (b) an exact id beats another entry's title that contains it;
 *   (c) several hits list every candidate and pick none;
 *   (d) no hit names the query and the kind;
 *   (e) archived projects and sessions take no part in matching;
 *   (f) with an ambiguous, unknown or substring-only target every write tool's
 *       control-service and host-service counters stay at 0 and the call answers
 *       `isError` — the substring-only case being AC-333's strict-write rule
 *       (an exact title still reaches the body);
 *   (g) the transport resolves a named project to its id before the tool body.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import type { McpReadToolDeps, McpResolveDeps, McpResolveResult, McpToolRegistrar } from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-resolve-target-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { sessionsService } = await import('@/modules/providers/index.js');
const { getArchivedProjectsWithSessions, getProjectsWithSessions } = await import('@/modules/projects/index.js');
const { MCP_GATEWAY_PATH, McpToolError, mountMcpGateway, resolveInputTargets, resolveMcpTarget, withMcpAudit } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;

/** Distinct enough that a substring query can only mean one of them. */
const ACTIVE_PROJECT_NAME = 'Active Project Marker';
const ARCHIVED_PROJECT_NAME = 'Archived Project Marker';

const SESSION_FOO = 'resolve-foo-bar';
const SESSION_SOLO_ACTIVE = 'resolve-solo-active';
const SESSION_SOLO_ARCHIVED = 'resolve-solo-archived';
const SESSION_DUP_ALPHA = 'resolve-dup-alpha';
const SESSION_DUP_BETA = 'resolve-dup-beta';
const SESSION_DUP_ARCHIVED = 'resolve-dup-archived';
/** Its id is a substring of {@link SESSION_LOOKALIKE}'s title, and vice versa is not true. */
const SESSION_EXACT = 'resolve-exact-target';
const SESSION_LOOKALIKE = 'resolve-exact-other';

/** The query that hits both active `Dup Marker` sessions and the archived one. */
const AMBIGUOUS_QUERY = 'Dup Marker';
/** A query no title contains. */
const UNKNOWN_QUERY = 'no-such-session-xyz';

const WRITE_TOOL_NAMES = ['session_send', 'session_interrupt', 'session_close'] as const;
type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

/** The principal the mount's `authorize` attaches: read tools need `cloudcli:read`. */
const PRINCIPAL = { userId: USER_ONE, tokenId: 1, clientId: null, scopes: ['cloudcli:read'] };

/** A write tool's two downstream services, counted per tool. */
type ServiceSpies = {
  control: Record<WriteToolName, number>;
  host: Record<WriteToolName, number>;
};

function zeroSpies(): ServiceSpies {
  const zero = (): Record<WriteToolName, number> => ({ session_send: 0, session_interrupt: 0, session_close: 0 });
  return { control: zero(), host: zero() };
}

// --------------------------- result narrowing ---------------------------

type FailedResolution = Extract<McpResolveResult, { ok: false }>;

/** The resolved id, asserting the reference resolved. */
function expectSuccess(result: McpResolveResult): string {
  assert.equal(result.ok, true, 'the reference must resolve');
  return result.id;
}

/** The refusal, asserting the reference did not resolve. */
function expectFailure(result: McpResolveResult): FailedResolution {
  assert.equal(result.ok, false, 'the reference must not resolve');
  return result;
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

/**
 * The SDK client's `fetch`, implemented over `node:http`, so a port undici
 * happens to refuse cannot red this criterion.
 */
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

// --------------------------- tool-call readings ---------------------------

type ToolCall = { isError: boolean; text: string; body: AnyRecord | null };

/** One tool result, with the envelope the gateway encodes its refusals in. */
function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let body: AnyRecord | null = null;
  // AC-284: a FAILURE carries `{ code, message, retryable, details? }` in
  // `structuredContent` — never a JSON string in the text. Read that first; a
  // SUCCESS payload is still rendered as the text body.
  if (call.isError === true && typeof call.structuredContent === 'object' && call.structuredContent !== null) {
    body = call.structuredContent as AnyRecord;
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      body = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
    } catch {
      body = null;
    }
  }
  return { isError: call.isError === true, text, body };
}

// --------------------------- harness ---------------------------

type Fixture = {
  /** The production wiring of the entry source: the ACTIVE listings only. */
  deps: McpResolveDeps;
  activeProjectId: string;
  archivedProjectId: string;
};

/**
 * Runs `run` against a fresh temp database holding two projects (one archived)
 * and eight sessions (two archived, one whose id collides with another's title).
 */
async function withResolveFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-resolve-target-'));
  const activeDirectory = path.join(tempDirectory, 'active-project');
  const archivedDirectory = path.join(tempDirectory, 'archived-project');
  await mkdir(activeDirectory, { recursive: true });
  await mkdir(archivedDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'resolve-target.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const activeProject = projectsDb.createProjectPath(activeDirectory, ACTIVE_PROJECT_NAME);
  const archivedProject = projectsDb.createProjectPath(archivedDirectory, ARCHIVED_PROJECT_NAME);
  assert.equal(activeProject.outcome, 'created', 'the active project fixture must be created');
  assert.equal(archivedProject.outcome, 'created', 'the archived project fixture must be created');
  const activeProjectRow = activeProject.project;
  const archivedProjectRow = archivedProject.project;
  assert.ok(activeProjectRow, 'the created active project must come back with its row');
  assert.ok(archivedProjectRow, 'the created archived project must come back with its row');
  projectsDb.updateProjectIsArchivedById(archivedProjectRow.project_id, true);

  const createdAt = '2026-09-01T10:00:00.000Z';
  const createSession = (sessionId: string, title: string, updatedAt: string): void => {
    sessionsDb.createSession(sessionId, 'claude', activeDirectory, title, createdAt, updatedAt);
  };
  createSession(SESSION_FOO, 'Foo Bar Session', '2026-09-01T11:00:00.000Z');
  createSession(SESSION_SOLO_ACTIVE, 'Solo Active Session', '2026-09-01T11:01:00.000Z');
  createSession(SESSION_SOLO_ARCHIVED, 'Solo Archived Session', '2026-09-01T11:02:00.000Z');
  createSession(SESSION_DUP_ALPHA, 'Dup Marker Alpha', '2026-09-01T11:03:00.000Z');
  createSession(SESSION_DUP_BETA, 'Dup Marker Beta', '2026-09-01T11:04:00.000Z');
  createSession(SESSION_DUP_ARCHIVED, 'Dup Marker Gamma', '2026-09-01T11:05:00.000Z');
  createSession(SESSION_EXACT, 'Exact Pointer Session', '2026-09-01T11:06:00.000Z');
  createSession(SESSION_LOOKALIKE, `prefix ${SESSION_EXACT} suffix`, '2026-09-01T11:07:00.000Z');
  sessionsDb.updateSessionIsArchived(SESSION_SOLO_ARCHIVED, true);
  sessionsDb.updateSessionIsArchived(SESSION_DUP_ARCHIVED, true);

  try {
    const activeProjects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
    const deps: McpResolveDeps = {
      listProjects: () => activeProjects.map((project) => ({ id: project.projectId, title: project.displayName })),
      listSessions: () =>
        sessionsService
          .listRecentSessions(200, 0)
          .conversations.map((session) => ({ id: session.sessionId, title: session.sessionTitle })),
    };

    await run({
      deps,
      activeProjectId: activeProjectRow.project_id,
      archivedProjectId: archivedProjectRow.project_id,
    });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The mount's `authorize`: every request carries a principal, so the audited seam admits it. */
const authorizeWithPrincipal: RequestHandler = (_req, res, next) => {
  res.locals.mcpPrincipal = PRINCIPAL;
  next();
};

type Connection = {
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  close: () => Promise<void>;
};

/**
 * Mounts the production `/mcp` endpoint with the given tool-set deps and returns
 * a connected SDK client.
 */
async function mountAndConnect(
  toolDeps: { registerTools?: McpToolRegistrar; readTools?: McpReadToolDeps; resolveDeps?: McpResolveDeps },
): Promise<Connection> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: authorizeWithPrincipal,
    ...toolDeps,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_GATEWAY_PATH}`), {
    fetch: nodeFetch,
  });
  const client = new Client({ name: 'ac246-criterion', version: '0.0.0' });
  await client.connect(transport);

  return {
    call: async (name, args = {}) =>
      parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0])),
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The three write tools as AC-249–AC-251 will register them: a `session` input,
 * through the SAME audited seam the read tools use, with AC-246's gate wrapped
 * around a body that touches the two downstream services. The tool NAME goes into
 * the gate (AC-333), so the strict-write rule reads each one's annotations — all
 * three are write tools, so all three refuse a substring-only target.
 */
function writeToolRegistrar(spies: ServiceSpies, deps: McpResolveDeps): McpToolRegistrar {
  return (server, principal) => {
    for (const name of WRITE_TOOL_NAMES) {
      const body = (args: AnyRecord): unknown => {
        // Reaching these is the side effect the gate exists to prevent.
        spies.control[name] += 1;
        spies.host[name] += 1;
        return { tool: name, session: args.session };
      };
      const guarded = resolveInputTargets(body, deps, name);
      withMcpAudit({
        name,
        description: `AC-246 criterion stand-in for ${name}.`,
        inputSchema: { session: z.string() },
        requiredScopes: [],
        handler: (args) => guarded(args as AnyRecord),
      })(server, principal);
    }
  };
}

/** The read-tool services, stubbed down to the one call `sessions_list` makes with a project. */
function readToolStubs(record: { projectIds: string[] }): McpReadToolDeps {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`the criterion did not expect a call to ${name}`);
  };
  return {
    projects: {
      getProjectsWithSessions: unexpected('getProjectsWithSessions'),
      getArchivedProjectsWithSessions: unexpected('getArchivedProjectsWithSessions'),
      getProjectSessionsPage: async (projectId) => {
        record.projectIds.push(projectId);
        return { projectId, sessions: [] };
      },
    },
    sessions: {
      listRecentSessions: () => ({ conversations: [], total: 0 }),
      readSessionLifecycle: () => null,
      fetchHistory: unexpected('fetchHistory'),
      fetchOutline: unexpected('fetchOutline'),
      fetchWindowAround: unexpected('fetchWindowAround'),
    },
    hosts: { snapshot: () => [], liveHostForSession: () => null },
    runs: { listRunningRuns: () => [] },
    now: () => Date.parse('2026-09-01T12:00:00.000Z'),
  };
}

// --------------------------- (a) case-insensitive substring ---------------------------

test('(a) a title substring resolves case-insensitively to the one matching entry', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    const lower = resolveMcpTarget('foo bar', 'session', fixture.deps);
    const upper = resolveMcpTarget('FOO BAR', 'session', fixture.deps);
    console.log(`[a] query="foo bar" result=${JSON.stringify(lower)}`);
    console.log(`[a] query="FOO BAR" result=${JSON.stringify(upper)}`);

    assert.equal(expectSuccess(lower), SESSION_FOO, '"foo bar" must resolve to the Foo Bar session');
    assert.equal(expectSuccess(upper), SESSION_FOO, 'the other casing must resolve to the SAME id');

    const project = resolveMcpTarget('active project', 'project', fixture.deps);
    console.log(`[a] query="active project" result=${JSON.stringify(project)}`);
    assert.equal(expectSuccess(project), fixture.activeProjectId, 'project names resolve by the same rule');
  });
});

// --------------------------- (b) exact id beats a substring ---------------------------

test('(b) an exact id wins over another entry whose title contains it', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    const result = resolveMcpTarget(SESSION_EXACT, 'session', fixture.deps);
    console.log(
      `[b] query="${SESSION_EXACT}" colliding title="${SESSION_LOOKALIKE}" title=${JSON.stringify(`prefix ${SESSION_EXACT} suffix`)} result=${JSON.stringify(result)}`,
    );

    assert.equal(
      expectSuccess(result),
      SESSION_EXACT,
      'the id that matches verbatim must win over the title that merely contains it',
    );
  });
});

// --------------------------- (c) ambiguity lists candidates ---------------------------

test('(c) several title hits list every candidate and select none', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    const result = expectFailure(resolveMcpTarget(AMBIGUOUS_QUERY, 'session', fixture.deps));
    console.log(`[c] query="${AMBIGUOUS_QUERY}" message=${JSON.stringify(result.message)}`);
    console.log(`[c] candidates=${JSON.stringify(result.candidates)}`);

    assert.equal(result.code, 'TARGET_AMBIGUOUS');
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id).sort(),
      [SESSION_DUP_ALPHA, SESSION_DUP_BETA],
      'the candidate set must be exactly the matching entries',
    );
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.title).sort(),
      ['Dup Marker Alpha', 'Dup Marker Beta'],
      'every candidate must carry its title, not just its id',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, 'id'),
      false,
      'a refusal must not carry a chosen id',
    );
    assert.ok(result.message.includes('name exactly one'), 'the message must ask the caller to choose');
    assert.ok(result.message.includes('will not pick'), 'the message must say the resolver will not choose');
  });
});

// --------------------------- (d) not-found names the query ---------------------------

test('(d) no hit names the query and the kind', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    for (const query of [UNKNOWN_QUERY, '', '   ']) {
      const result = expectFailure(resolveMcpTarget(query, 'session', fixture.deps));
      console.log(`[d] query=${JSON.stringify(query)} message=${JSON.stringify(result.message)}`);
      assert.equal(result.code, 'SESSION_NOT_FOUND');
      assert.deepEqual(result.candidates, [], 'a not-found carries no candidates');
      assert.equal(result.kind, 'session');
      assert.ok(result.message.includes(query.trim()), 'the message must name what was looked for');
      assert.ok(result.message.includes('session'), 'the message must name the kind it looked among');
    }

    const project = expectFailure(resolveMcpTarget('nothing-like-this', 'project', fixture.deps));
    console.log(`[d] project query message=${JSON.stringify(project.message)}`);
    assert.equal(project.kind, 'project');
    assert.ok(project.message.includes('project'), 'the project refusal names the project kind');
  });
});

// --------------------------- (e) archived entries take no part ---------------------------

test('(e) archived projects and sessions are never matched and never listed', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    // Fixture sanity first: the archive writes really landed, so the negative
    // readings below are "the resolver did not see it", not "it never existed".
    const archivedProjects = await getArchivedProjectsWithSessions({ skipSynchronization: true });
    const activeProjects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
    const archivedSessions = sessionsService.listArchivedSessions();
    const recentSessions = sessionsService.listRecentSessions(200, 0).conversations;
    console.log(`[e] archived project names=${JSON.stringify(archivedProjects.map((project) => project.displayName))}`);
    console.log(`[e] active project names=${JSON.stringify(activeProjects.map((project) => project.displayName))}`);
    console.log(`[e] archived session titles=${JSON.stringify(archivedSessions.map((session) => session.sessionTitle))}`);
    console.log(`[e] recent session titles=${JSON.stringify(recentSessions.map((session) => session.sessionTitle))}`);

    assert.ok(
      archivedProjects.some((project) => project.projectId === fixture.archivedProjectId),
      'the archived project must exist in the archived listing',
    );
    assert.equal(
      activeProjects.some((project) => project.projectId === fixture.archivedProjectId),
      false,
      'the archived project must be absent from the active listing the resolver reads',
    );
    assert.ok(
      archivedSessions.some((session) => session.sessionId === SESSION_SOLO_ARCHIVED),
      'the archived session must exist in the archived listing',
    );
    assert.equal(
      recentSessions.some((session) => session.sessionId === SESSION_SOLO_ARCHIVED),
      false,
      'the archived session must be absent from the active listing the resolver reads',
    );

    // The archived project: unreachable by name, while the active one resolves.
    const archivedProjectQuery = resolveMcpTarget(ARCHIVED_PROJECT_NAME, 'project', fixture.deps);
    const activeProjectQuery = resolveMcpTarget(ACTIVE_PROJECT_NAME, 'project', fixture.deps);
    console.log(`[e] archived project query result=${JSON.stringify(archivedProjectQuery)}`);
    console.log(`[e] active project query result=${JSON.stringify(activeProjectQuery)}`);
    assert.equal(expectFailure(archivedProjectQuery).code, 'PROJECT_NOT_FOUND');
    assert.equal(expectSuccess(activeProjectQuery), fixture.activeProjectId);

    // The archived session: unreachable by name, while the active one resolves.
    const archivedSessionQuery = resolveMcpTarget('Solo Archived', 'session', fixture.deps);
    const activeSessionQuery = resolveMcpTarget('Solo Active', 'session', fixture.deps);
    console.log(`[e] archived session query result=${JSON.stringify(archivedSessionQuery)}`);
    console.log(`[e] active session query result=${JSON.stringify(activeSessionQuery)}`);
    assert.equal(expectFailure(archivedSessionQuery).code, 'SESSION_NOT_FOUND');
    assert.equal(expectSuccess(activeSessionQuery), SESSION_SOLO_ACTIVE);

    // And the archived session is not smuggled into an ambiguity's candidate list.
    const ambiguous = expectFailure(resolveMcpTarget(AMBIGUOUS_QUERY, 'session', fixture.deps));
    console.log(`[e] ambiguous candidates=${JSON.stringify(ambiguous.candidates.map((candidate) => candidate.id))}`);
    assert.equal(
      ambiguous.candidates.some((candidate) => candidate.id === SESSION_DUP_ARCHIVED),
      false,
      'the archived session must not appear among the candidates',
    );
  });
});

// --------------------------- (f) unclear target, zero side effects ---------------------------

test('(f) an unclear target leaves every write tool with zero service calls', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    const spies = zeroSpies();
    const connection = await mountAndConnect({ registerTools: writeToolRegistrar(spies, fixture.deps) });
    try {
      // (c) ambiguous target, for each write tool.
      for (const name of WRITE_TOOL_NAMES) {
        const call = await connection.call(name, { session: AMBIGUOUS_QUERY });
        console.log(`[f] ${name} session="${AMBIGUOUS_QUERY}" isError=${call.isError} body=${call.text}`);
        assert.equal(call.isError, true, `${name} must refuse an ambiguous target`);
        assert.equal(call.body?.code, 'TARGET_AMBIGUOUS');
        const details = call.body?.details as AnyRecord | undefined;
        assert.equal(details?.query, AMBIGUOUS_QUERY, 'the refusal must name the query that was ambiguous');
        assert.ok(Array.isArray(details?.candidates), 'the refusal must carry the candidate list');
      }
      console.log(
        `[f] after ambiguous: control=${JSON.stringify(spies.control)} host=${JSON.stringify(spies.host)}`,
      );
      assert.deepEqual(spies.control, zeroSpies().control, 'no write tool may reach the control service');
      assert.deepEqual(spies.host, zeroSpies().host, 'no write tool may reach the host service');

      // (d) unknown target, for each write tool.
      for (const name of WRITE_TOOL_NAMES) {
        const call = await connection.call(name, { session: UNKNOWN_QUERY });
        console.log(`[f] ${name} session="${UNKNOWN_QUERY}" isError=${call.isError} body=${call.text}`);
        assert.equal(call.isError, true, `${name} must refuse an unknown target`);
        assert.equal(call.body?.code, 'SESSION_NOT_FOUND');
        const details = call.body?.details as AnyRecord | undefined;
        assert.equal(details?.query, UNKNOWN_QUERY, 'the refusal must name the query that found nothing');
        assert.deepEqual(details?.candidates, []);
      }
      console.log(
        `[f] after unknown: control=${JSON.stringify(spies.control)} host=${JSON.stringify(spies.host)}`,
      );
      assert.deepEqual(spies.control, zeroSpies().control, 'still no control-service call');
      assert.deepEqual(spies.host, zeroSpies().host, 'still no host-service call');

      // (AC-333) A SUBSTRING-ONLY target — it names exactly one entry, but only by
      // fragment — is refused for a WRITE, for every write tool. `Solo Active` is a
      // substring of `Solo Active Session` and nothing else, so the fuzzy layer
      // would resolve it; the strict rule says a fragment discovers a target, it
      // does not address one for a mutation. The refusal reuses `TARGET_AMBIGUOUS`
      // with the `exact_target_required` marker and the single matched candidate.
      for (const name of WRITE_TOOL_NAMES) {
        const call = await connection.call(name, { session: 'Solo Active' });
        console.log(`[f] ${name} session="Solo Active" isError=${call.isError} body=${call.text}`);
        assert.equal(call.isError, true, `${name} must refuse a substring-only target`);
        assert.equal(call.body?.code, 'TARGET_AMBIGUOUS');
        const details = call.body?.details as AnyRecord | undefined;
        assert.equal(details?.reason, 'exact_target_required', 'the refusal must carry the strict marker');
        assert.equal(details?.query, 'Solo Active');
        assert.deepEqual(
          (details?.candidates as Array<{ id?: string }>).map((candidate) => candidate.id),
          [SESSION_SOLO_ACTIVE],
          'the refusal must name the single entry the fragment would have picked',
        );
      }
      console.log(
        `[f] after substring-only: control=${JSON.stringify(spies.control)} host=${JSON.stringify(spies.host)}`,
      );
      assert.deepEqual(spies.control, zeroSpies().control, 'a substring-only target may not reach the control service');
      assert.deepEqual(spies.host, zeroSpies().host, 'a substring-only target may not reach the host service');

      // Positive control: an EXACT title — not a fragment — DOES reach the body,
      // with the resolved id. (`Solo Active Session` is the whole title, so it
      // resolves by the exact-title layer and the strict rule lets it through.)
      const resolved = await connection.call('session_send', { session: 'Solo Active Session' });
      console.log(
        `[f] session_send session="Solo Active Session" isError=${resolved.isError} body=${resolved.text} control=${spies.control.session_send} host=${spies.host.session_send}`,
      );
      assert.equal(resolved.isError, false, 'a unique exact hit must reach the handler');
      assert.equal(resolved.body?.session, SESSION_SOLO_ACTIVE, 'the handler must see the RESOLVED id');
      assert.equal(spies.control.session_send, 1);
      assert.equal(spies.host.session_send, 1);
      // The other two tools were never entered by the positive call.
      assert.equal(spies.control.session_interrupt, 0);
      assert.equal(spies.control.session_close, 0);
      assert.equal(spies.host.session_interrupt, 0);
      assert.equal(spies.host.session_close, 0);
    } finally {
      await connection.close();
    }
  });
});

// --------------------------- (g) the transport gates its own tools ---------------------------

test('(g) the transport resolves a named project to its id before the tool body runs', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    const record = { projectIds: [] as string[] };
    const connection = await mountAndConnect({
      readTools: readToolStubs(record),
      resolveDeps: fixture.deps,
    });
    try {
      const resolved = await connection.call('sessions_list', { project: 'Active Project' });
      console.log(
        `[g] sessions_list project="Active Project" isError=${resolved.isError} body=${resolved.text} projectIds=${JSON.stringify(record.projectIds)} expected=${fixture.activeProjectId}`,
      );
      assert.equal(resolved.isError, false);
      assert.deepEqual(
        record.projectIds,
        [fixture.activeProjectId],
        'the read tool must receive the resolved id, not the name',
      );

      const refused = await connection.call('sessions_list', { project: 'Archived Project' });
      console.log(`[g] sessions_list project="Archived Project" isError=${refused.isError} body=${refused.text}`);
      assert.equal(refused.isError, true, 'an unresolved project must refuse the call');
      assert.equal(refused.body?.code, 'PROJECT_NOT_FOUND');
      assert.deepEqual(record.projectIds, [fixture.activeProjectId], 'the refused call must not reach the service');
    } finally {
      await connection.close();
    }
  });
});

// --------------------------- (h) an array target resolves element-wise ---------------------------

test('(h) the gate resolves an array element-wise and refuses the whole call on one bad element', { concurrency: false }, async () => {
  await withResolveFixture(async (fixture) => {
    // A capture handler: being entered is the side effect, and the bag it receives
    // is exactly what the gate resolved.
    const seen: AnyRecord[] = [];
    const guarded = resolveInputTargets((args) => {
      seen.push(args);
      return args;
    }, fixture.deps);

    // Two resolvable references in ONE array resolve to their two distinct ids —
    // the element-wise reading the array extension promises. `Foo Bar` is a title
    // fragment; the other is already an id.
    const resolved = guarded({ session: ['Foo Bar', SESSION_SOLO_ACTIVE] }) as AnyRecord;
    console.log(`[h] session=["Foo Bar","${SESSION_SOLO_ACTIVE}"] -> ${JSON.stringify(resolved.session)}`);
    assert.deepEqual(
      resolved.session,
      [SESSION_FOO, SESSION_SOLO_ACTIVE],
      'every element must be rewritten to its resolved id, in order',
    );
    assert.equal(seen.length, 1, 'a successful array resolves the handler exactly once');

    // An EMPTY array names nobody, so it resolves to an empty array rather than
    // being refused — "no project" is what an empty list says.
    const empty = guarded({ session: [] }) as AnyRecord;
    assert.deepEqual(empty.session, [], 'an empty array is not a target and must not be refused');

    // An AMBIGUOUS element refuses the whole call BEFORE the handler runs, even
    // though its sibling resolves: no partially-resolved array reaches the body.
    const before = seen.length;
    assert.throws(
      () => guarded({ session: [AMBIGUOUS_QUERY, SESSION_SOLO_ACTIVE] }),
      (error: unknown) => {
        assert.ok(error instanceof McpToolError, 'the refusal must be the audited error envelope');
        return (error as { code?: string }).code === 'TARGET_AMBIGUOUS';
      },
      'an ambiguous element must refuse the call',
    );
    assert.equal(seen.length, before, 'an ambiguous element must stop the handler from running');

    // A NOT-FOUND element refuses the same way — one code for the category.
    assert.throws(
      () => guarded({ session: [SESSION_SOLO_ACTIVE, 'no-such-session-xyzzy'] }),
      (error: unknown) => (error as { code?: string }).code === 'SESSION_NOT_FOUND',
      'a not-found element must refuse the call',
    );
    assert.equal(seen.length, before, 'a not-found element must stop the handler from running');

    // A non-string element rides through untouched: the declared schema is where a
    // wrong element type is rejected, not this gate.
    const passedThrough = guarded({ session: [SESSION_SOLO_ACTIVE, 42] }) as AnyRecord;
    assert.deepEqual(passedThrough.session, [SESSION_SOLO_ACTIVE, 42], 'a non-string element is not a reference');
  });
});
