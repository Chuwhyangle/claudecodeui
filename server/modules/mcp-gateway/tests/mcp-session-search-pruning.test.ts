/**
 * gap-mcp-session-search-time-pruning-and-stable-cursor criterion: `session_search`
 * prunes by time BEFORE it scans, and pages a capped scan without loss or
 * duplication.
 *
 * Everything below is real except the one verb each reading is about. A real
 * express application carries the production `/mcp` mount behind the production
 * token middleware; the client is the MCP SDK's own `Client`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are real rows whose
 * transcripts are real Claude JSONL files on disk. The search engine is the
 * SAME `sessionConversationsSearchService.search` the session-search route uses
 * (imported from the providers barrel — never by path).
 *
 * Readings, one leg each:
 *   (a) `since` / `until` prune sessions BEFORE the scan: an INJECTED scanner
 *       records every file it is handed, and the assertion is that an
 *       out-of-window session's transcript was never among them;
 *   (b) with a SMALL injected file cap, the first page reports `hasMore` and a
 *       cursor, and paging the cursor to exhaustion covers every matching
 *       session exactly once (no loss, no duplication);
 *   (c) BOTH cursor encodings page: the legacy base64 skip-count still skips,
 *       and the new keyset token resumes where the last page stopped;
 *   (d) each hit's `turnIndex` equals the `#index` `session_read({ mode:
 *       'outline' })` prints for the same turn id;
 *   (e) the change adds a plain index, not a full-text table: the whole `server`
 *       tree matches neither `CREATE VIRTUAL TABLE` nor `fts5`.
 *
 * The cap leg's falsification is deliberate and manual: deleting the `slice(0,
 * maxScannedFiles)` guard in `sessionConversationsSearchService` makes (b) red,
 * because the first page then exhausts the corpus and reports `hasMore: false`.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time, so the
// environment is set before any aliased module is pulled in — every application
// module below therefore comes in dynamically (the order AC-245 established).
process.env.JWT_SECRET = 'mcp-session-search-pruning-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { sessionConversationsSearchService, sessionsService } = await import('@/modules/providers/index.js');
const { getProjectsWithSessions } = await import('@/modules/projects/index.js');
const { MCP_GATEWAY_PATH, createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- the clock ---------------------------

/** The injected instant every relative reading is measured against. */
const NOW_ISO = '2026-09-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const WORKSPACE_DIR_NAME = 'prune-workspace';

/** The one literal term every planted message carries — a token no other text in this repo contains. */
const KEYWORD = 'pruneword';

/**
 * Five sessions in ONE project, newest first by `updated_at`, each backed by its
 * own transcript file. Five > a cap of two, so the capped leg needs three slabs
 * and a real resumption; and the span 12:00..08:00 lets `since` cut cleanly
 * between 10:00 and 09:00 for the pruning leg.
 */
const SESSIONS: ReadonlyArray<{ id: string; updatedAt: string; keywordTurn: 'first' | 'second' }> = [
  { id: 'prune-fixture-a', updatedAt: '2026-09-01T12:00:00.000Z', keywordTurn: 'first' },
  { id: 'prune-fixture-b', updatedAt: '2026-09-01T11:00:00.000Z', keywordTurn: 'second' },
  { id: 'prune-fixture-c', updatedAt: '2026-09-01T10:00:00.000Z', keywordTurn: 'second' },
  { id: 'prune-fixture-d', updatedAt: '2026-09-01T09:00:00.000Z', keywordTurn: 'second' },
  { id: 'prune-fixture-e', updatedAt: '2026-09-01T08:00:00.000Z', keywordTurn: 'second' },
];

/** The `since` that keeps a/b/c (12:00/11:00/10:00) and cuts d/e (09:00/08:00). */
const SINCE_MID = '2026-09-01T09:30:00.000Z';

/** A file cap small enough that five transcripts cannot fit one slab. */
const SMALL_FILE_CAP = 2;

// --------------------------- transcript fixture ---------------------------

function userRow(uuid: string, parentUuid: string | null, timestamp: string, sessionId: string, text: string): AnyRecord {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantRow(uuid: string, parentUuid: string, timestamp: string, sessionId: string, text: string): AnyRecord {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/**
 * One transcript with two user text turns and an assistant reply after each.
 * `keywordTurn` puts the matching user message in the FIRST turn or the SECOND,
 * so `turnIndex` differs per session and cannot pass by always reading 0.
 */
function buildRows(sessionId: string, keywordTurn: 'first' | 'second'): AnyRecord[] {
  const stamp = '2026-09-01T10:00:00.000Z';
  const u1 = `${sessionId}-u1`;
  const a1 = `${sessionId}-a1`;
  const u2 = `${sessionId}-u2`;
  const a2 = `${sessionId}-a2`;
  const firstText = keywordTurn === 'first' ? `The ${KEYWORD} note lives here.` : 'Nothing notable in this turn.';
  const secondText = keywordTurn === 'second' ? `The ${KEYWORD} note lives here.` : 'Nothing notable in this turn.';
  return [
    userRow(u1, null, stamp, sessionId, firstText),
    assistantRow(a1, u1, stamp, sessionId, 'Acknowledged.'),
    userRow(u2, a1, stamp, sessionId, secondText),
    assistantRow(a2, u2, stamp, sessionId, 'Acknowledged again.'),
  ];
}

async function writeTranscript(projectDirectory: string, sessionId: string, rows: AnyRecord[]): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

/** The SDK client's `fetch`, over `node:http` — `listen(0)` on this host lands on a port undici refuses at random. */
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

// --------------------------- harness ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null; structured: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks
    .map((block) => (block as { type?: string; text?: string }).text ?? '')
    .join('');
  let payload: AnyRecord | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
  } catch {
    payload = null;
  }
  return {
    isError: call.isError === true,
    text,
    payload,
    structured: (call.structuredContent as AnyRecord | undefined) ?? null,
  };
}

/**
 * The one injected scan seam. A leg that leaves it empty exercises the REAL
 * ripgrep scanner; a leg that sets `scanFiles` records (or fakes) the scan; a
 * leg that sets `maxScannedFiles` shrinks the file ceiling without planting 200
 * transcripts.
 */
type ScanSeam = {
  maxScannedFiles?: number;
  scanFiles?: (pattern: string, filePaths: string[], signal?: AbortSignal) => Promise<Set<string>>;
};

type Harness = {
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  seam: ScanSeam;
};

type Fixture = {
  projectId: string;
  transcriptPathBySession: Map<string, string>;
};

/**
 * Runs `run` against a fresh temp database and the real `/mcp` mount carrying
 * `session_search`.
 *
 * The `search` verb is the real engine, with the caller's {@link ScanSeam}
 * spread onto its input — so `maxScannedFiles` / `scanFiles` reach the engine
 * while everything else (window pruning, ordering, caps, paging) is production
 * code.
 */
async function withPruningSearch(run: (harness: Harness, fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-session-search-pruning-'));
  const workspaceDirectory = path.join(tempDirectory, WORKSPACE_DIR_NAME);
  await mkdir(workspaceDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-search-pruning.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const transcriptPathBySession = new Map<string, string>();
  for (const session of SESSIONS) {
    const transcriptPath = await writeTranscript(workspaceDirectory, session.id, buildRows(session.id, session.keywordTurn));
    transcriptPathBySession.set(session.id, transcriptPath);
    sessionsDb.createSession(
      session.id,
      'claude',
      workspaceDirectory,
      `Prune ${session.id}`,
      session.updatedAt,
      session.updatedAt,
      transcriptPath,
    );
  }

  const projects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
  const projectId = projects.find((project) => project.path === workspaceDirectory)?.projectId;
  assert.ok(projectId, 'the fixture project must be registered');

  const tokens = createAccessTokensService({ now: () => new Date(NOW_MS) });
  const readToken = tokens.issueToken({ userId: USER_ONE, name: 'mcp-search-pruning', scopes: ['cloudcli:read'], expiresInDays: 30 });
  if (!readToken.ok) {
    throw new Error('the harness must mint a cloudcli:read token');
  }

  const seam: ScanSeam = {};
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    resolveDeps: {
      listProjects: () => projects.map((project) => ({ id: project.projectId, title: project.displayName })),
      listSessions: () =>
        sessionsDb.getAllSessions().map((row) => ({
          id: row.session_id,
          title: row.custom_name?.trim() || row.session_id,
        })),
    },
    readTools: {
      projects: {
        getProjectsWithSessions,
        getArchivedProjectsWithSessions: async () => [],
        getProjectSessionsPage: async (id: string) => ({ projectId: id, sessions: [], total: 0 }),
        getProjectIdByPath: () => projectId,
      },
      sessions: sessionsService,
      hosts: { snapshot: () => [], liveHostForSession: () => null },
      runs: { listRunningRuns: () => [] },
      now,
      sessionSearch: {
        search: (input) => sessionConversationsSearchService.search({ ...input, ...seam }),
        now,
      },
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${readToken.token.token}` } },
    fetch: nodeFetch,
  });
  const client = new Client({ name: 'gap-mcp-session-search-pruning-criterion', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  try {
    await run({ call, seam }, { projectId, transcriptPathBySession });
  } finally {
    await transport.close().catch(() => undefined);
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

/** The session ids of a successful `session_search` reading, in the order returned. */
function hitIds(call: ToolCall): string[] {
  return ((call.payload?.results as AnyRecord[] | undefined) ?? []).map((hit) => String(hit.sessionId));
}

// --------------------------- (a)..(d): one fixture, one mount ---------------------------

test('session_search prunes by time, pages a capped scan, and aligns turnIndex', { concurrency: false }, async (t) => {
  await withPruningSearch(async ({ call, seam }, fixture) => {
    const allIds = SESSIONS.map((session) => session.id);
    const inWindowIds = SESSIONS.filter((session) => session.updatedAt >= SINCE_MID).map((session) => session.id);
    const outOfWindowIds = SESSIONS.filter((session) => session.updatedAt < SINCE_MID).map((session) => session.id);

    await t.test('(a) since/until prune before the scan: an excluded transcript is never handed to the scanner', async () => {
      const scannedPaths: string[] = [];
      seam.scanFiles = async (pattern, filePaths) => {
        scannedPaths.push(...filePaths);
        const matched = new Set<string>();
        for (const filePath of filePaths) {
          const content = await readFile(filePath, 'utf8');
          if (content.toLowerCase().includes(pattern.toLowerCase())) {
            matched.add(filePath);
          }
        }
        return matched;
      };

      const result = await call('session_search', { query: KEYWORD, since: SINCE_MID });
      assert.equal(result.isError, false, result.text);
      const ids = hitIds(result);

      // The reading itself: only in-window sessions came back.
      assert.deepEqual([...ids].sort(), [...inWindowIds].sort(), 'only in-window sessions are returned');
      for (const id of outOfWindowIds) {
        assert.ok(!ids.includes(id), `${id} is outside the window and must not be returned`);
      }

      // The scanner reading: the excluded transcripts were NEVER scanned.
      const scanned = new Set(scannedPaths);
      assert.ok(scannedPaths.length > 0, 'the in-window transcripts must actually be scanned');
      for (const id of outOfWindowIds) {
        const transcriptPath = fixture.transcriptPathBySession.get(id) as string;
        assert.ok(!scanned.has(transcriptPath), `${id}'s transcript must never be handed to the scanner`);
      }
      for (const id of inWindowIds) {
        const transcriptPath = fixture.transcriptPathBySession.get(id) as string;
        assert.ok(scanned.has(transcriptPath), `${id}'s transcript is in the window and must be scanned`);
      }

      // scannedThrough is the OLDEST activity the scan actually read.
      const oldestInWindow = SESSIONS.filter((session) => inWindowIds.includes(session.id))
        .map((session) => session.updatedAt)
        .sort()[0];
      const scannedThrough = result.payload?.scannedThrough as { iso?: string } | null;
      assert.equal(scannedThrough?.iso, oldestInWindow, 'scannedThrough reports the oldest scanned activity');
      console.log(`[a] in-window=${inWindowIds.join(',')} scanned=${scannedPaths.length} scannedThrough=${scannedThrough?.iso}`);

      delete seam.scanFiles;
    });

    await t.test('(b) a small file cap pages: hasMore true, and the cursor walk covers every session once', async () => {
      seam.maxScannedFiles = SMALL_FILE_CAP;

      const first = await call('session_search', { query: KEYWORD });
      assert.equal(first.isError, false, first.text);
      assert.equal(first.payload?.hasMore, true, 'a capped first page must report hasMore');
      assert.equal(typeof first.payload?.nextCursor, 'string', 'a capped first page must carry nextCursor');
      assert.ok(hitIds(first).length < allIds.length, 'the cap must actually truncate the first page');
      console.log(`[b] page1=${hitIds(first).join(',')} hasMore=${first.payload?.hasMore}`);

      const seen: string[] = [];
      let cursor: string | undefined = first.payload?.nextCursor as string | undefined;
      let page = first;
      let guard = 0;
      while (cursor !== undefined) {
        seen.push(...hitIds(page));
        assert.ok(guard++ < 20, 'paging must terminate');
        page = await call('session_search', { query: KEYWORD, cursor });
        assert.equal(page.isError, false, page.text);
        cursor = page.payload?.nextCursor as string | undefined;
      }
      seen.push(...hitIds(page));

      assert.deepEqual([...seen].sort(), [...allIds].sort(), 'the walk covers every matching session');
      assert.equal(new Set(seen).size, seen.length, 'no session is returned twice across the walk');
      console.log(`[b] walk=${seen.join(',')}`);

      delete seam.maxScannedFiles;
    });

    await t.test('(c) both cursor encodings page: the legacy skip count and the new keyset token', async () => {
      // The legacy cursor is base64 of an integer, with no version prefix.
      const legacy = Buffer.from('1', 'utf8').toString('base64');
      const legacyCall = await call('session_search', { query: KEYWORD, limit: 50, cursor: legacy });
      assert.equal(legacyCall.isError, false, legacyCall.text);
      const full = await call('session_search', { query: KEYWORD, limit: 50 });
      const fullIds = hitIds(full);
      assert.deepEqual(hitIds(legacyCall), fullIds.slice(1), 'the legacy skip-count cursor still skips one session');
      console.log(`[c] legacy=${hitIds(legacyCall).join(',')}`);

      // The new keyset cursor resumes disjointly from the previous page.
      const pageOne = await call('session_search', { query: KEYWORD, limit: 2 });
      const keyset = pageOne.payload?.nextCursor as string | undefined;
      assert.equal(typeof keyset, 'string', 'a truncated page carries the keyset token');
      assert.ok(keyset !== legacy, 'the emitted token is the versioned keyset form, not the legacy skip count');
      const pageTwo = await call('session_search', { query: KEYWORD, limit: 2, cursor: keyset });
      const pageOneIds = hitIds(pageOne);
      const pageTwoIds = hitIds(pageTwo);
      assert.equal(pageOneIds.length, 2, 'page one is a full page of two');
      assert.ok(pageTwoIds.every((id) => !pageOneIds.includes(id)), 'page two is disjoint from page one');
      assert.ok(pageOneIds.length + pageTwoIds.length <= allIds.length, 'two pages cannot exceed the corpus');
      console.log(`[c] keyset page1=${pageOneIds.join(',')} page2=${pageTwoIds.join(',')}`);
    });

    await t.test('(d) every hit turnIndex equals the #index session_read(mode: outline) prints', async () => {
      const search = await call('session_search', { query: KEYWORD, limit: 50 });
      assert.equal(search.isError, false, search.text);
      const hits = (search.payload?.results as AnyRecord[] | undefined) ?? [];
      assert.ok(hits.length > 0, 'the fixture must produce hits');

      const nonZero: number[] = [];
      for (const hit of hits) {
        const sessionId = String(hit.sessionId);
        const outline = await call('session_read', { session: sessionId, mode: 'outline' });
        assert.equal(outline.isError, false, outline.text);
        // The tool's reading is `[timestamp] #index id: preview` per turn; read it
        // from the unescaped `content` field (the raw text block is JSON, whose
        // newlines are escaped and would hide every line but the first).
        const content = typeof outline.payload?.content === 'string' ? outline.payload.content : outline.text;
        const indexById = new Map<string, number>();
        for (const match of content.matchAll(/#(\d+) (\S+):/g)) {
          indexById.set(match[2] as string, Number(match[1]));
        }
        assert.ok(indexById.size > 0, `${sessionId}: the outline must print at least one turn`);

        for (const message of (hit.matches as AnyRecord[] | undefined) ?? []) {
          const messageId = message.messageId;
          if (typeof messageId !== 'string') {
            continue;
          }
          assert.equal(
            message.turnIndex,
            indexById.get(messageId) ?? null,
            `${sessionId}/${messageId}: turnIndex must be the outline #index`,
          );
          if (typeof message.turnIndex === 'number' && message.turnIndex !== 0) {
            nonZero.push(message.turnIndex);
          }
        }
      }
      assert.ok(nonZero.length > 0, 'at least one hit must sit at a non-zero turn, or the alignment proves nothing');
      console.log(`[d] non-zero turnIndex readings=${nonZero.join(',')}`);
    });
  });
});

// --------------------------- (e) no full-text table ---------------------------

test('(e) the pruning adds a plain index, never a full-text table', () => {
  const files = [
    'server/modules/providers/services/session-conversations-search.service.ts',
    'server/modules/mcp-gateway/mcp-session-search.ts',
    'server/modules/mcp-gateway/mcp-gateway.read-tools.ts',
    'server/modules/database/schema.ts',
    'server/modules/database/migrations.ts',
  ];
  for (const relative of files) {
    const source = readFileSync(relative, 'utf8');
    assert.doesNotMatch(source, /CREATE\s+VIRTUAL\s+TABLE/i, `${relative} must not create a virtual (full-text) table`);
    assert.doesNotMatch(source, /fts5/i, `${relative} must not use fts5`);
  }

  // The one schema change the task permits: a plain b-tree index on the column
  // the query reads, present in both the fresh schema and the migration path.
  const schema = readFileSync('server/modules/database/schema.ts', 'utf8');
  const migrations = readFileSync('server/modules/database/migrations.ts', 'utf8');
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions\(updated_at\)/);
  assert.match(migrations, /CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions\(updated_at\)/);
});
