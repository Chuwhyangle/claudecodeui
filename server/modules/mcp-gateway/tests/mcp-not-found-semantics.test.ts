/**
 * AC-287 criterion: on four MCP tools, "the reference names nothing" is an
 * ERROR — not an apparent success — while a REAL state of a REAL entity stays a
 * success result.
 *
 *   (a) `approval_answer` for an expired or never-minted `requestId` is an
 *       `isError` envelope `APPROVAL_NOT_FOUND`; `details.reason` distinguishes
 *       a request this process HELD and dropped (`'expired'`) from one it never
 *       minted (`'never_issued'`). The old `ok:false` success payload is gone.
 *   (b) `session_cancel_queued` for a uuid the session's queue never held —
 *       including another session's uuid — is an `isError` envelope
 *       `QUEUED_MESSAGE_NOT_FOUND`; a message that was really dequeued and
 *       started stays a SUCCESS whose `outcome` is `'already-started'`, and the
 *       success enum `['cancelled','already-started']` is read back off a real
 *       `tools/list`.
 *   (c) `run_get` for a run aged past retention, a runId never handed out, and a
 *       run belonging to a previous boot is an `isError` envelope `RUN_NOT_FOUND`
 *       whose `details.reason` is `'expired'` / `'never_issued'` and whose
 *       `details.fallback.messages` is the session's recent messages verbatim. A
 *       hit is still a success.
 *   (d) `quay_snapshot` for a project id nothing matches is an `isError`
 *       envelope; a project that EXISTS without `.quay/config.yml` stays a
 *       SUCCESS reading `status: 'no_quay_config'`; an existing project with
 *       config stays a success too. The two cases are no longer conflated.
 *   (e) The invariants: (b)'s `already-started`, (d)'s `no_quay_config` and
 *       (c)'s hit are successes — the real states were not moved onto the error
 *       side.
 *
 * ## AC5 deviation, recorded here on purpose
 *
 * AC5 (and the goal's (d)) name the missing-project code as the literal
 * `TARGET_NOT_FOUND`. That literal is UNSATISFIABLE in this repository and this
 * criterion therefore asserts `PROJECT_NOT_FOUND`, the project-side code of the
 * one-code-per-category vocabulary:
 *
 *   1. `MCP_ERROR_CODES` has no `TARGET_NOT_FOUND` member, and AC-285's achieved
 *      criterion (`tests/mcp-error-vocabulary.test.ts`) deep-equals the
 *      vocabulary's key set in BOTH directions at runtime — adding the code
 *      would red it.
 *   2. AC-284's achieved criterion (`tests/mcp-error-envelope.test.ts`) scans
 *      `server/modules/mcp-gateway/*.ts` and FAILS if the literal
 *      `TARGET_NOT_FOUND` appears at all: AC-284's goal retired it ("不再出现
 *      `SESSION_NOT_FOUND` 与 `TARGET_NOT_FOUND` 两种说法并存").
 *   3. AC-284's criterion already maps project-not-found -> `PROJECT_NOT_FOUND`.
 *
 * The task record carries the conflict and its resolution; AC5 is left unticked
 * and the task is parked `needs-human` rather than faking the literal or
 * assembling it at runtime.
 *
 * ## What is real
 *
 * A real express 4 application carries the production `/mcp` mount behind the
 * production token middleware; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`; the database is a real better-sqlite3 file in
 * a temp directory; the sessions and projects are real rows; the control service
 * is the real `createChatControlService`; the run registry is the real
 * `createChatRunRegistry` with an injected clock and boot. Only the provider
 * RUNTIME is a fake (pending approvals, the cancel verdicts) — except for the
 * approval distinction, which is read from the REAL claude approval ledger
 * through `providerRuntimeService.classifyMissingApproval`: this criterion arms
 * the real ledger with `requestClientToolDecision` and then abandons the wait, so
 * a genuinely held-then-dropped id reads `'expired'` and an id nothing armed
 * reads `'never_issued'`. The distinction is透出 by the control plane, not
 * guessed by this adapter.
 *
 * Two clients: `probeClient` never calls `tools/list`, so every ERROR envelope is
 * read back verbatim (an `isError` result skips the SDK's output validation);
 * `listClient` warms `tools/list` once — it is where the `outputSchema` enum is
 * read from, and its success calls are validated against that schema.
 *
 * The transport is handed a `node:http`-based `fetch`: `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/247/248/274's criteria document the same hazard).
 *
 * The false forms (AC7) mutate the implementation after this criterion is green;
 * they are recorded in the task's change notes.
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

import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';
import type { QuaySnapshot } from '@/modules/quay/index.js';
import type { ActivityProtocolSnapshot } from '@/modules/websocket/index.js';

// --------------------------------------------------------------------------
// A scratch HOME is set before any aliased module is imported, so settings reads
// land on an empty directory (the posture AC-274/AC-248/AC-247's criteria take).
// --------------------------------------------------------------------------
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-not-found-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-not-found-semantics-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { ACCESS_TOKEN_SCOPES, createAccessTokensService } = await import('@/modules/oauth/index.js');
const { providerRuntimeService, requestClientToolDecision, sessionsService } = await import(
  '@/modules/providers/index.js'
);
const { createChatControlService, createChatRunRegistry } = await import('@/modules/websocket/index.js');
const { getProjectsWithSessions } = await import('@/modules/projects/index.js');
const { MCP_GATEWAY_PATH, NO_QUAY_NOTE, createMcpAuthMiddleware, mountMcpGateway } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
/** Every scope the vocabulary declares: the four tools sit under four of them. */
const ALL_SCOPES = [...ACCESS_TOKEN_SCOPES];

/** The instant every relative reading is measured against. */
const BASE_MS = Date.parse('2026-09-01T12:00:00.000Z');

/** The two real project directories; each carries a real session row. */
const WITH_CONFIG_DIR = 'ac287-with-config';
const WITHOUT_CONFIG_DIR = 'ac287-without-config';

/** The real session ids (written directly, so the criterion names them). */
const SESSION_MAIN = 'ac287-session-main';
const SESSION_COLD = 'ac287-session-cold';
/** Two further sessions only the run_get probes use. */
const SESSION_RESTARTED = 'ac287-session-restarted';
const SESSION_HIT = 'ac287-session-hit';

/** The boot the fake process starts as. Flipping it simulates a restart. */
const BOOT_ONE = 'ac287-boot-0001';
const BOOT_TWO = 'ac287-boot-0002';

/** The approval request ids: one the real ledger held then dropped, one never armed. */
const R_HELD = 'ac287-req-held-then-dropped';
const R_NEVER = 'ac287-req-never-minted';

/** The queued-message uuids, by the verdict the session's queue gives them. */
const UUID_WITHDRAWN = 'ac287-uuid-withdrawn';
const UUID_STARTED = 'ac287-uuid-already-started';
const UUID_NEVER = 'ac287-uuid-never-returned';
/** A uuid that belongs to ANOTHER session's queue. */
const UUID_CROSS = 'ac287-uuid-cross-session';

/** A project id nothing matches. */
const MISSING_PROJECT = 'ac287-no-such-project';

/** The fixture history the run_get fallback must read verbatim. */
const FIXTURE_MESSAGES: NormalizedMessage[] = [
  {
    id: 'ac287-msg-user',
    sessionId: SESSION_MAIN,
    timestamp: '2026-09-01T11:58:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: '运行是什么样的？',
  },
  {
    id: 'ac287-msg-assistant-last',
    sessionId: SESSION_MAIN,
    timestamp: '2026-09-01T11:59:30.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: '还在运行。',
  },
];

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`mcp-not-found ${line}`);
}

/** A complete `QuaySnapshot` for the fake cache of the one configured project. */
function makeSnapshot(projectId: string, projectPath: string): QuaySnapshot {
  return {
    projectId,
    projectPath,
    generatedAt: new Date(BASE_MS).toISOString(),
    cached: true,
    driver: { state: 'idle', alive: false, running: false, lastRecordAt: null },
    tasks: { total: 0, byStatus: {}, ready: 0, needsHuman: 0, done: 0, recent: [] },
    goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
    adrs: { total: 0, recent: [] },
    configIssues: { total: 0, errors: 0 },
    tests: { current: null, recentRounds: [] },
    fanIn: { recent: [] },
    inFlight: null,
    gantt: null,
    dashboardUrl: null,
    warnings: [],
  };
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
  const call = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  // AC-284: a FAILURE carries its machine fields in `structuredContent`
  // (`{ code, message, retryable, details? }`) instead of a JSON string stuffed
  // into the text. Read that first; a SUCCESS payload is still the text body.
  if (call.isError === true && typeof call.structuredContent === 'object' && call.structuredContent !== null) {
    payload = call.structuredContent as AnyRecord;
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
    } catch {
      payload = null;
    }
  }
  return { isError: call.isError === true, text, payload };
}

/** The `details` object of an error envelope, with one legible failure when absent. */
function detailsOf(call: ToolCall, label: string): AnyRecord {
  const details = call.payload?.details;
  assert.ok(
    typeof details === 'object' && details !== null,
    `${label}: the error envelope must carry details (payload=${JSON.stringify(call.payload)})`,
  );
  return details as AnyRecord;
}

// --------------------------- the fake runtime ---------------------------

type PendingSeed = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  receivedAt: Date;
};

/**
 * The provider runtime the real control service is handed.
 *
 * Only the five members the control verbs read are implemented. The approval
 * DISTINCTION is deliberately NOT a stub: `classifyMissingApproval` delegates to
 * the real `providerRuntimeService`, so the `'expired'` vs `'never_issued'`
 * reading is the claude ledger's own, not this file's opinion.
 */
function createFakeRuntime(seed: PendingSeed[], verdicts: {
  withdrawn: Map<string, Set<string>>;
  started: Map<string, Set<string>>;
}) {
  const pendingBySession = new Map<string, PendingSeed[]>();
  for (const entry of seed) {
    const bucket = pendingBySession.get(entry.sessionId) ?? [];
    bucket.push(entry);
    pendingBySession.set(entry.sessionId, bucket);
  }
  const resolveCalls: Array<{ requestId: string; decision: AnyRecord }> = [];
  const cancelCalls: Array<{ sessionId: string; messageUuid: string }> = [];

  return {
    getPendingApprovalsForSession(sessionId: string): PendingSeed[] {
      return pendingBySession.get(sessionId) ?? [];
    },
    resolveToolApproval(requestId: string, decision: unknown): void {
      resolveCalls.push({ requestId, decision: decision as AnyRecord });
    },
    /** Reads the REAL claude ledger through the providers facade. */
    classifyMissingApproval(requestId: string) {
      return providerRuntimeService.classifyMissingApproval(requestId) ?? 'expired';
    },
    async cancelQueuedInput(
      _provider: LLMProvider,
      sessionId: string,
      messageUuid: string,
    ): Promise<string> {
      cancelCalls.push({ sessionId, messageUuid });
      if (verdicts.withdrawn.get(sessionId)?.has(messageUuid) === true) {
        return 'withdrawn';
      }
      if (verdicts.started.get(sessionId)?.has(messageUuid) === true) {
        return 'already-started';
      }
      return 'unknown';
    },
    /** Removes every pending entry for `requestId` — the timeout transition. */
    removePending(requestId: string): void {
      for (const [sessionId, bucket] of pendingBySession) {
        pendingBySession.set(
          sessionId,
          bucket.filter((entry) => entry.requestId !== requestId),
        );
      }
    },
    resolveCalls,
    cancelCalls,
  };
}

/** Counts how many times the spy saw `requestId`. */
function resolveCountFor(calls: Array<{ requestId: string }>, requestId: string): number {
  return calls.filter((call) => call.requestId === requestId).length;
}

// --------------------------- the harness ---------------------------

type Harness = {
  /** Calls a tool on the never-listing client (error envelopes read verbatim). */
  probe: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  /** Calls a tool on the client that warmed `tools/list` (successes get validated). */
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  /** The `session_cancel_queued` outputSchema enum, read off a real `tools/list`. */
  outcomeEnum: () => Promise<unknown[]>;
  /** The project id of the project a fixture session lives in. */
  projectIdFor: (session: string) => string;
  resolveCalls: Array<{ requestId: string; decision: AnyRecord }>;
  cancelCalls: Array<{ sessionId: string; messageUuid: string }>;
  removePending(requestId: string): void;
  /** The real claude ledger's own classification of `requestId`. */
  classify: (requestId: string) => string | null;
  /** Starts a run for `session` and returns its id. */
  startRun: (session: string) => string;
  completeRun: (session: string) => void;
  /** Advances the fake clock. */
  advance: (ms: number) => void;
  /** Flips the process boot — the "服务已重启" transition. */
  restart: () => void;
  clock: () => number;
};

/**
 * Boots one arm: a fresh temp database + two real project directories, four real
 * sessions, the real control service over the fake runtime, one all-scopes token,
 * and the production `/mcp` mount carrying the stage-3 read tools (who/quay) plus
 * the stage-6 resident tools (cancel-queued + approvals).
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const dirByProject = new Map<string, string>([
    [SESSION_MAIN, path.join(tempDirectory, WITH_CONFIG_DIR)],
    [SESSION_COLD, path.join(tempDirectory, WITHOUT_CONFIG_DIR)],
  ]);
  for (const dir of dirByProject.values()) {
    mkdirSync(dir, { recursive: true });
  }

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'mcp-not-found.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  // Four real session rows in two real project directories (`path` is the exact
  // directory string the projects reader reports, which is how the criterion
  // resolves a project id).
  const rows: Array<[string, string]> = [
    [SESSION_MAIN, dirByProject.get(SESSION_MAIN) as string],
    [SESSION_COLD, dirByProject.get(SESSION_COLD) as string],
    [SESSION_RESTARTED, dirByProject.get(SESSION_MAIN) as string],
    [SESSION_HIT, dirByProject.get(SESSION_MAIN) as string],
  ];
  for (const [sessionId, dir] of rows) {
    sessionsDb.createSession(
      sessionId,
      'claude',
      dir,
      `ac287 ${sessionId}`,
      '2026-09-01T11:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
      null,
    );
  }

  const projects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
  const projectIdByDir = new Map(projects.map((project) => [project.path, project.projectId]));
  const withConfigId = projectIdByDir.get(dirByProject.get(SESSION_MAIN) as string);
  const withoutConfigId = projectIdByDir.get(dirByProject.get(SESSION_COLD) as string);
  assert.ok(withConfigId, 'the with-config project must be registered');
  assert.ok(withoutConfigId, 'the without-config project must be registered');

  // ---- the run registry: a real one, with the injected clock and boot ----
  const runtime = { clock: BASE_MS, currentBoot: BOOT_ONE };
  const registry = createChatRunRegistry({
    now: () => runtime.clock,
    bootId: () => runtime.currentBoot,
  });
  const now = (): number => runtime.clock;

  const activity = {
    snapshot: (sessionId: string): ActivityProtocolSnapshot | null =>
      sessionId === SESSION_HIT
        ? {
            sessionId,
            bootId: BOOT_ONE,
            rev: 1,
            asOf: BASE_MS,
            turn: { phase: 'tool', toolName: 'Bash', toolDurationMs: null },
            tasks: [],
            schedules: [],
          }
        : null,
  };

  /** The queued-uuid verdicts the fake queue holds, per session. */
  const verdicts = {
    withdrawn: new Map<string, Set<string>>([[SESSION_MAIN, new Set([UUID_WITHDRAWN])]]),
    started: new Map<string, Set<string>>([[SESSION_MAIN, new Set([UUID_STARTED])]]),
  };
  const fakeRuntime = createFakeRuntime(
    // The approval fixture: one id this process holds (then drops), keyed to the
    // main session so `findApprovalSession` can see it while it is live.
    [
      {
        requestId: R_HELD,
        sessionId: SESSION_MAIN,
        toolName: 'Bash',
        input: { command: 'echo hi' },
        receivedAt: new Date(BASE_MS - 1_000),
      },
    ],
    verdicts,
  );
  const control = createChatControlService({
    runtime: fakeRuntime as never,
    listApprovalSessionIds: () => [SESSION_MAIN, SESSION_COLD],
  });

  // Arm the REAL claude ledger: `requestClientToolDecision` records the id at
  // arm time and registers a live resolver; aborting the wait finalizes it and
  // deletes the pending entry, leaving exactly the ledger trace `'expired'`
  // means. `R_NEVER` is never armed, so it reads `'never_issued'`.
  const controller = new AbortController();
  const armed = requestClientToolDecision({
    toolName: 'Bash',
    input: { command: 'echo hi' },
    requiresInteraction: false,
    requestId: R_HELD,
    ws: { send: () => undefined } as never,
    emitNotification: () => undefined,
    sessionId: SESSION_MAIN,
    sessionSummary: null,
    signal: controller.signal,
  });
  controller.abort();
  await armed;

  // ---- the injected quay runner: a path check, a cache, one refresh ----
  // Only the configured project carries a snapshot; the config-less one has no
  // config at all, so its reading is the `no_quay_config` success, not a miss.
  const cachedSnapshots = new Map<string, QuaySnapshot>([
    [withConfigId, makeSnapshot(withConfigId, dirByProject.get(SESSION_MAIN) as string)],
  ]);
  const refreshCounts = new Map<string, number>();
  const quay = {
    hasQuayConfig: (projectId: string) => projectId === withConfigId,
    readCached: (projectId: string) => cachedSnapshots.get(projectId) ?? null,
    refresh: async (projectId: string) => {
      refreshCounts.set(projectId, (refreshCounts.get(projectId) ?? 0) + 1);
      return cachedSnapshots.get(projectId) ?? null;
    },
  };

  // ---- the token: one, carrying every scope ----
  const tokens = createAccessTokensService({ now: () => new Date(BASE_MS) });
  const issued = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac287-criterion',
    scopes: ALL_SCOPES,
    expiresInDays: 30,
  });
  if (!issued.ok) {
    throw new Error('the harness must mint the criterion token');
  }

  // ---- the app and the real mount ----
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools: {
      projects: {
        getProjectsWithSessions,
        getArchivedProjectsWithSessions: async () => [],
        getProjectSessionsPage: async (projectId: string) => ({ projectId, sessions: [] }),
      },
      sessions: sessionsService,
      hosts: { snapshot: () => [], liveHostForSession: () => null },
      runs: registry,
      activity,
      quay,
      runGet: {
        runs: registry,
        activity,
        sessions: {
          fetchHistory: async (_sessionId: string, options: { limit: number }) => ({
            messages: FIXTURE_MESSAGES.slice(-options.limit),
          }),
        },
        now,
        sleep: async () => undefined,
        bootId: () => runtime.currentBoot,
      },
      now,
    },
    residentTools: {
      control: control as never,
      approvals: { control: control as never, now },
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${issued.token.token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac287-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const probeSide = await connect();
  const listSide = await connect();

  const callWith = async (
    which: 'probe' | 'list',
    name: string,
    args: AnyRecord,
  ): Promise<ToolCall> =>
    parseToolResult(
      await (which === 'list' ? listSide.client : probeSide.client).callTool({
        name,
        arguments: args,
      } as Parameters<Client['callTool']>[0]),
    );

  try {
    await run({
      probe: (name, args = {}) => callWith('probe', name, args),
      call: (name, args = {}) => callWith('list', name, args),
      async outcomeEnum() {
        const listed = await listSide.client.listTools();
        const tool = listed.tools.find((entry) => entry.name === 'session_cancel_queued');
        assert.ok(tool, 'tools/list must register session_cancel_queued');
        const output = tool.outputSchema as AnyRecord | undefined;
        const properties = output?.properties as AnyRecord | undefined;
        const outcome = properties?.outcome as AnyRecord | undefined;
        const values = outcome?.enum;
        assert.ok(Array.isArray(values), `the tool must advertise an outcome enum (outputSchema=${JSON.stringify(output)})`);
        return values as unknown[];
      },
      projectIdFor: (session: string) =>
        projectIdByDir.get(dirByProject.get(session) as string) as string,
      resolveCalls: fakeRuntime.resolveCalls,
      cancelCalls: fakeRuntime.cancelCalls,
      removePending: (requestId) => fakeRuntime.removePending(requestId),
      classify: (requestId) => providerRuntimeService.classifyMissingApproval(requestId),
      startRun: (session: string) => {
        const opened = registry.startRun({
          appSessionId: session,
          provider: 'claude' as LLMProvider,
          providerSessionId: null,
          connection: null,
          userId: null,
        });
        assert.ok(opened, `the fixture must open a run for ${session}`);
        return opened.runId;
      },
      completeRun: (session: string) => {
        registry.completeRun(session, { exitCode: 0 });
      },
      advance: (ms: number) => {
        runtime.clock += ms;
      },
      restart: () => {
        runtime.currentBoot = BOOT_TWO;
      },
      clock: () => runtime.clock,
    });
  } finally {
    await probeSide.transport.close().catch(() => undefined);
    await listSide.transport.close().catch(() => undefined);
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

// =====================================================================
// (a) approval_answer: a miss is APPROVAL_NOT_FOUND with a real reason
// =====================================================================

test('(a) approval_answer: expired and never-minted are APPROVAL_NOT_FOUND errors, reasons distinguished', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const minted = await harness.call('approvals_list', { session: SESSION_MAIN });
    const present = (minted.payload?.approvals ?? []) as Array<{ requestId: string }>;
    assert.equal(
      present.some((entry) => entry.requestId === R_HELD),
      true,
      'positive control: the request must be listed while the control plane still holds it',
    );

    // The timeout transition: the registry drops the id. The real ledger keeps
    // the trace, which is exactly what the control plane reads back.
    harness.removePending(R_HELD);

    const expired = await harness.probe('approval_answer', { requestId: R_HELD, allow: true });
    const never = await harness.probe('approval_answer', { requestId: R_NEVER, allow: true });

    const expiredDetails = detailsOf(expired, '(a) expired');
    const neverDetails = detailsOf(never, '(a) never');

    say(`(a) expired isError=${expired.isError} payload=${JSON.stringify(expired.payload)}`);
    say(`(a) never   isError=${never.isError} payload=${JSON.stringify(never.payload)}`);
    say(`(a) expired details keys=${JSON.stringify(Object.keys(expiredDetails).sort())}`);
    say(`(a) never   details keys=${JSON.stringify(Object.keys(neverDetails).sort())}`);
    say(`(a) ledger classify: held=${JSON.stringify(harness.classify(R_HELD))} never=${JSON.stringify(harness.classify(R_NEVER))}`);
    say(`(a) resolveCalls=${JSON.stringify(harness.resolveCalls)}`);

    // The DoD's "控制面把区分透出，不是适配器猜测": the real ledger itself
    // classifies the two ids differently before any envelope is built.
    assert.equal(harness.classify(R_HELD), 'expired', 'the real claude ledger must read a held-then-dropped id as expired');
    assert.equal(harness.classify(R_NEVER), 'never_issued', 'the real claude ledger must read an unarmed id as never_issued');

    for (const [label, call, payload] of [
      ['expired', expired, expiredDetails],
      ['never', never, neverDetails],
    ] as const) {
      assert.equal(call.isError, true, `(${label}) a miss must be an error (text=${call.text})`);
      assert.equal(call.payload?.code, 'APPROVAL_NOT_FOUND', `(${label}) the envelope code must be APPROVAL_NOT_FOUND`);
      assert.equal(typeof call.payload?.message, 'string', `(${label}) the envelope must carry a message`);
      assert.equal((call.payload?.message as string).trim().length > 0, true, `(${label}) the message must be non-empty`);
      assert.equal(call.payload?.retryable, false, `(${label}) a miss is not retryable`);
      // The old shape is gone: no `ok` field, and the retired code never appears.
      assert.equal(call.payload?.ok, undefined, `(${label}) the old ok payload must be gone`);
      assert.equal(call.text.includes('APPROVAL_EXPIRED_OR_NOT_FOUND'), false, `(${label}) the retired code must not reach the wire`);
      assert.deepEqual(Object.keys(payload).sort(), ['reason'], `(${label}) details carries exactly the reason`);
    }

    assert.equal(expiredDetails.reason, 'expired', 'a held-then-dropped request reads expired');
    assert.equal(neverDetails.reason, 'never_issued', 'a never-minted request reads never_issued');
    assert.notEqual(expiredDetails.reason, neverDetails.reason, 'the two reasons must be mutually distinct');

    assert.equal(resolveCountFor(harness.resolveCalls, R_HELD), 0, 'an expired request never reaches the resolver');
    assert.equal(resolveCountFor(harness.resolveCalls, R_NEVER), 0, 'a never-minted request never reaches the resolver');
  });
});

// =====================================================================
// (b) session_cancel_queued: unknown uuid is an error, already-started is not
// =====================================================================

test('(b) session_cancel_queued: never-held uuid is QUEUED_MESSAGE_NOT_FOUND, already-started is a success', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const never = await harness.probe('session_cancel_queued', {
      session: SESSION_MAIN,
      messageUuid: UUID_NEVER,
    });
    const cross = await harness.probe('session_cancel_queued', {
      session: SESSION_MAIN,
      messageUuid: UUID_CROSS,
    });
    const started = await harness.call('session_cancel_queued', {
      session: SESSION_MAIN,
      messageUuid: UUID_STARTED,
    });
    const withdrawn = await harness.call('session_cancel_queued', {
      session: SESSION_MAIN,
      messageUuid: UUID_WITHDRAWN,
    });
    const enumValues = await harness.outcomeEnum();

    say(`(b) never   isError=${never.isError} payload=${JSON.stringify(never.payload)}`);
    say(`(b) cross   isError=${cross.isError} payload=${JSON.stringify(cross.payload)}`);
    say(`(b) started isError=${started.isError} payload=${JSON.stringify(started.payload)}`);
    say(`(b) withdrawn isError=${withdrawn.isError} payload=${JSON.stringify(withdrawn.payload)}`);
    say(`(b) cancelCalls=${JSON.stringify(harness.cancelCalls)}`);
    say(`(b) outputSchema outcome enum=${JSON.stringify(enumValues)}`);

    assert.equal(never.isError, true, `a uuid never returned must be an error (text=${never.text})`);
    assert.equal(never.payload?.code, 'QUEUED_MESSAGE_NOT_FOUND', 'a never-held uuid reads QUEUED_MESSAGE_NOT_FOUND');
    assert.equal(cross.isError, true, `another session's uuid must be an error (text=${cross.text})`);
    assert.equal(cross.payload?.code, 'QUEUED_MESSAGE_NOT_FOUND', "another session's uuid reads QUEUED_MESSAGE_NOT_FOUND");
    // The error is not an outcome: the old third success value must not appear.
    assert.equal(never.payload?.outcome, undefined, 'an error must not carry a success outcome');
    assert.equal(cross.payload?.outcome, undefined, 'an error must not carry a success outcome');

    assert.equal(started.isError, false, `an already-started message must stay a success (text=${started.text})`);
    assert.equal(started.payload?.outcome, 'already-started', 'a dequeued message reads already-started');
    assert.equal(started.payload?.session, SESSION_MAIN, 'the success echoes the session');
    assert.equal(started.payload?.messageUuid, UUID_STARTED, 'the success echoes the uuid');
    assert.equal(withdrawn.isError, false, `a real withdrawal must stay a success (text=${withdrawn.text})`);
    assert.equal(withdrawn.payload?.outcome, 'cancelled', 'a withdrawn message reads cancelled');

    // AC3(iii): the success enum is read back off a real `tools/list`.
    assert.deepEqual(
      [...(enumValues as string[])].sort(),
      ['already-started', 'cancelled'],
      'the advertised outcome enum is exactly the two real success outcomes',
    );
  });
});

// =====================================================================
// (c) run_get: a miss is RUN_NOT_FOUND with a reason and the fallback read
// =====================================================================

test('(c) run_get: expired, never-issued and restarted are RUN_NOT_FOUND errors carrying the fallback', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    // -- expired: a completed run pushed past the registry's retention window --
    const expiredId = harness.startRun(SESSION_MAIN);
    harness.completeRun(SESSION_MAIN);
    harness.advance(5 * 60 * 1000 + 1);

    const expired = await harness.probe('run_get', { runId: expiredId, session: SESSION_MAIN });

    // -- never issued: an id nothing ever handed out --
    const neverId = 'ac287-run-never-issued';
    const never = await harness.probe('run_get', { runId: neverId, session: SESSION_MAIN });

    // -- restarted: the run's record still exists but belongs to another boot --
    const restartedId = harness.startRun(SESSION_RESTARTED);
    harness.restart();
    const restarted = await harness.probe('run_get', { runId: restartedId });

    // -- the hit: a run opened under the CURRENT boot is still a success --
    const hitId = harness.startRun(SESSION_HIT);
    const hit = await harness.call('run_get', { runId: hitId });

    const expiredDetails = detailsOf(expired, '(c) expired');
    const neverDetails = detailsOf(never, '(c) never');
    const restartedDetails = detailsOf(restarted, '(c) restarted');

    say(`(c) expired   isError=${expired.isError} payload=${JSON.stringify(expired.payload)}`);
    say(`(c) never     isError=${never.isError} payload=${JSON.stringify(never.payload)}`);
    say(`(c) restarted isError=${restarted.isError} payload=${JSON.stringify(restarted.payload)}`);
    say(`(c) hit       isError=${hit.isError} status=${JSON.stringify(hit.payload?.status)}`);

    for (const [label, call] of [
      ['expired', expired],
      ['never', never],
      ['restarted', restarted],
    ] as const) {
      assert.equal(call.isError, true, `(${label}) a miss must be an error (text=${call.text})`);
      assert.equal(call.payload?.code, 'RUN_NOT_FOUND', `(${label}) the envelope code must be RUN_NOT_FOUND`);
      assert.equal((call.payload?.message as string).trim().length > 0, true, `(${label}) the message must be non-empty`);
      // The old success-shaped miss fields must not survive.
      assert.equal(call.payload?.status, undefined, `(${label}) a miss must not carry a success status`);
      assert.equal(call.payload?.explanation, undefined, `(${label}) the retired explanation field must be gone`);
    }

    assert.equal(expiredDetails.reason, 'expired', 'a run past retention reads expired');
    assert.equal(neverDetails.reason, 'never_issued', 'an id never handed out reads never_issued');
    assert.equal(restartedDetails.reason, 'expired', 'a run from a previous boot is no longer reachable — expired');
    assert.equal(restartedDetails.bootId, BOOT_TWO, 'the restarted reading names the CURRENT boot');

    // The three sentences stay distinct: the restarted one really says the
    // service restarted (AC-289: caller-facing copy is English-only).
    assert.match(String(restarted.payload?.message), /restarted/i, 'the restarted sentence must say the service restarted');
    assert.notEqual(expired.payload?.message, never.payload?.message, 'the expiry and never-issued sentences differ');

    // Each miss carries the fallback read of its session, verbatim.
    for (const [label, details, expectedSession] of [
      ['expired', expiredDetails, SESSION_MAIN],
      ['never', neverDetails, SESSION_MAIN],
      ['restarted', restartedDetails, SESSION_RESTARTED],
    ] as const) {
      const fallback = details.fallback as AnyRecord;
      assert.equal(fallback.session, expectedSession, `(${label}) the fallback names the right session`);
      assert.deepEqual(fallback.messages, FIXTURE_MESSAGES, `(${label}) the fallback messages must be verbatim`);
      assert.equal((fallback.messages as unknown[]).length > 0, true, `(${label}) the fallback must not be empty`);
    }

    // (e) the hit is still a success.
    assert.equal(hit.isError, false, `a hit must stay a success (text=${hit.text})`);
    assert.equal(hit.payload?.status, 'running', 'the hit reports the running run');
    assert.equal(hit.payload?.runId, hitId, 'the hit names the run');
  });
});

// =====================================================================
// (d) quay_snapshot: a missing project is an error, no-quay-config is not
// =====================================================================

test('(d) quay_snapshot: a missing project errors, an existing config-less project succeeds', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const missing = await harness.probe('quay_snapshot', { project: MISSING_PROJECT });
    const noConfig = await harness.call('quay_snapshot', {
      project: harness.projectIdFor(SESSION_COLD),
    });
    const withConfig = await harness.call('quay_snapshot', {
      project: harness.projectIdFor(SESSION_MAIN),
    });
    const refreshed = await harness.call('quay_snapshot', {
      project: harness.projectIdFor(SESSION_MAIN),
      refresh: true,
    });

    say(`(d) missing   isError=${missing.isError} payload=${JSON.stringify(missing.payload)}`);
    say(`(d) noConfig  isError=${noConfig.isError} payload=${JSON.stringify(noConfig.payload)}`);
    say(`(d) withConfig isError=${withConfig.isError} status=${JSON.stringify(withConfig.payload?.status)}`);
    say(`(d) refreshed isError=${refreshed.isError} status=${JSON.stringify(refreshed.payload?.status)}`);

    assert.equal(missing.isError, true, `a project id nothing matches must be an error (text=${missing.text})`);
    // AC5's literal is `TARGET_NOT_FOUND`; see the file header — the vocabulary
    // retired it and AC-284's criterion fails if it reappears, so the intent is
    // expressed with the one project-not-found code.
    assert.equal(missing.payload?.code, 'PROJECT_NOT_FOUND', 'a missing project reads the project-not-found code');
    assert.equal(detailsOf(missing, '(d) missing').project, MISSING_PROJECT, 'the details name the missing project');
    assert.equal(missing.payload?.status, undefined, 'an error must not carry a success status');

    assert.equal(noConfig.isError, false, `an existing config-less project must stay a success (text=${noConfig.text})`);
    assert.equal(noConfig.payload?.status, 'no_quay_config', 'the config-less reading states no_quay_config');
    assert.equal(noConfig.payload?.hasQuayConfig, false, 'the config-less reading states there is no config');
    assert.equal(noConfig.payload?.note, NO_QUAY_NOTE, 'the config-less reading explains itself in words');

    assert.equal(withConfig.isError, false, `an existing configured project must stay a success (text=${withConfig.text})`);
    assert.equal(withConfig.payload?.status, 'cached', 'the configured project reads its cached snapshot');
    assert.equal(refreshed.isError, false, `a refresh of a real project must stay a success (text=${refreshed.text})`);
    assert.equal(refreshed.payload?.status, 'refreshed', 'the refresh reads the reloaded snapshot');
  });
});

// =====================================================================
// (e) the invariants, read together
// =====================================================================

test('(e) the real states stay successes: already-started, no_quay_config and a run hit', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const started = await harness.call('session_cancel_queued', {
      session: SESSION_MAIN,
      messageUuid: UUID_STARTED,
    });
    const noConfig = await harness.call('quay_snapshot', {
      project: harness.projectIdFor(SESSION_COLD),
    });
    const hitId = harness.startRun(SESSION_HIT);
    const hit = await harness.call('run_get', { runId: hitId });

    say(`(e) already-started isError=${started.isError} outcome=${JSON.stringify(started.payload?.outcome)}`);
    say(`(e) no_quay_config  isError=${noConfig.isError} status=${JSON.stringify(noConfig.payload?.status)}`);
    say(`(e) run hit         isError=${hit.isError} status=${JSON.stringify(hit.payload?.status)}`);

    // If the miss semantics were over-applied, any of these three would flip to
    // `isError` — that is exactly what false form (ii) mutates.
    assert.equal(started.isError, false, 'already-started must stay a success');
    assert.equal(started.payload?.outcome, 'already-started', 'already-started is a real outcome');
    assert.equal(noConfig.isError, false, 'no_quay_config must stay a success');
    assert.equal(noConfig.payload?.status, 'no_quay_config', 'no_quay_config is a real status');
    assert.equal(hit.isError, false, 'a run hit must stay a success');
    assert.equal(hit.payload?.status, 'running', 'the hit reports a real status');
  });
});
