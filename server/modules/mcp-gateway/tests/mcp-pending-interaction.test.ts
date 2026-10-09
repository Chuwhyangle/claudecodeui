/**
 * Criterion: a session parked on a human-facing request is VISIBLE from the tools
 * a client already calls, and answering one is IDEMPOTENT.
 *
 * The incident this criterion pins: a resident session sat on an
 * `AskUserQuestion` and an external MCP client polling `session_get` saw only
 * `host.state === 'busy'` — nothing said a person was being waited on — so it
 * read a healthy park as a stall. `approvals_list` could already expand the
 * question, but the caller had to know to ask THAT tool.
 *
 * Readings, one leg each:
 *   (a) VISIBILITY / AC3 — with a real `AskUserQuestion` parked on the primary
 *       session, `session_get(session).pendingInteraction` is non-null and its
 *       `requestId` / `toolName` / `questions` are byte-identical to the entry
 *       `approvals_list({session})` reports for the same request; the same
 *       session's `sessions_list` row reads `awaitingUser === true`; the clean
 *       session (`coldSessionId`) reads `pendingInteraction === null` and
 *       `awaitingUser === false` — the positive control that the field is derived
 *       from a real pending set and not always-true.
 *   (b) POLICY / AC4 — a parked ordinary permission (`Bash`) reads
 *       `interactive === false` with `autoTimeoutMs === TOOL_APPROVAL_TIMEOUT_MS`
 *       (the INJECTED value, so a hard-coded 55000 cannot pass); a parked
 *       `AskUserQuestion` and `ExitPlanMode` read `interactive === true` with
 *       `autoTimeoutMs === null`. `approvals_list`'s entries carry the same two
 *       fields, because both surfaces read one `describeApprovalPolicy`.
 *   (c) RACE / AC5 — two concurrent `approval_answer` calls for one `requestId`
 *       (one `allow:true`, one `allow:false`): `resolveToolApproval` is called
 *       exactly once, the winner returns `ok`, and the loser returns the
 *       forwarded `ALREADY_DECIDED` code carrying `decidedBy` / `decidedAt` —
 *       NOT `APPROVAL_NOT_FOUND` (`expired` / `never_issued`), which would claim
 *       an id that WAS answered never existed.
 *   (d) SCOPE / AC7 — a `cloudcli:read`-only token reads the new fields but its
 *       `approval_answer` is refused with a `denied` audit row and writes NO
 *       ledger record; an `cloudcli:approve`-only token can answer but cannot
 *       read the session; the read+approve token answers, and its ledger record
 *       is what a SECOND answer reads back as `ALREADY_DECIDED`.
 *   (e) ALIGNMENT / AC8 — `approvals_list({})`'s pending-session set equals
 *       `overview()`'s `awaitingPermission` set, and a session with no pending
 *       request is in neither.
 *
 * ## What is real
 *
 * A real express 4 application carries the production `/mcp` mount behind the
 * production token middleware; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`; the database is a real better-sqlite3 file in
 * a temp directory; the two sessions are real rows; the control service is the
 * real `createChatControlService`. Unlike AC-274's criterion, the approval
 * SOURCE here is the REAL claude runtime: the pending request is armed through
 * the production `requestClientToolDecision` (the one seam the per-run and
 * resident paths share) with the tool's own `requiresInteraction` taken from
 * `describeApprovalPolicy`, and the control service's runtime is the real
 * `providerRuntimeService` behind a counting shim — so "was the resolver called"
 * is a reading of the real resolver, not a spy's.
 *
 * The turn phase is real too: arming feeds the real Turn Tracker, so `overview`'s
 * `awaitingPermission` and the park are the same signal rather than two
 * bookkeepings of it. The activity store is the real `createActivityStore`.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/247/248/249/271/272/273/274's criteria document the same hazard).
 *
 * The false form (AC10) mutates the implementation after this criterion is
 * green; it is recorded in the task's change notes.
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

// --------------------------------------------------------------------------
// A scratch HOME and the INJECTED approval deadline are set before any aliased
// module is imported. The deadline is not the default: leg (b) asserts the
// reported `autoTimeoutMs` equals this value, which a hard-coded 55000 could
// never satisfy.
// --------------------------------------------------------------------------
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-pending-interaction-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-pending-interaction-test-secret';
process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS = '4321';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const {
  TOOL_APPROVAL_TIMEOUT_MS,
  describeApprovalPolicy,
  providerRuntimeService,
  requestClientToolDecision,
  sessionsService,
} = await import('@/modules/providers/index.js');
const { createActivityStore, createChatControlService } = await import('@/modules/websocket/index.js');
const { MCP_GATEWAY_PATH, createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const READ_SCOPE = 'cloudcli:read';
const APPROVE_SCOPE = 'cloudcli:approve';
/** The deadline leg (b) asserts was INJECTED, not the 55000 default. */
const INJECTED_TIMEOUT_MS = 4321;
/** The instant every relative reading is measured against. */
const NOW = Date.now();

/** The ordinary permission whose request id and arm are this criterion's own. */
const R_BASH = 'pend-bash';
/** The parked question whose expansion leg (a) compares verbatim. */
const R_ASK_PARK = 'pend-ask-park';
/** The two further interactive parks of leg (b). */
const R_ASK_POLICY = 'pend-ask-policy';
const R_PLAN = 'pend-plan';
/** The request leg (c) races two answers against. */
const R_RACE = 'pend-race';
/** The request leg (d) proves the ledger is written by the approved caller. */
const R_SCOPE = 'pend-scope';
/** The request leg (e) parks while both scan surfaces are read. */
const R_ALIGN = 'pend-align';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`mcp-pending-interaction ${line}`);
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
  // A FAILURE carries its machine fields in `structuredContent`
  // (`{ code, message, retryable, details? }`) instead of a JSON string stuffed
  // into the text; a SUCCESS payload is still the text body (AC-284).
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

/** An audit row as this criterion reads it back. */
type AuditRow = { id: number; tool: string; outcome: string; denied_scopes: string | null };

/** A decision ledger record as this criterion reads it back. */
type LedgerRecord = { decidedAt: number; decidedBy: string | null; allow: boolean | null };

// --------------------------- the harness ---------------------------

type ArmSpec = { toolName: string; requestId: string; input: unknown };

type TokenName = 'read' | 'readApprove' | 'approveOnly';

type Harness = {
  sessionId: string;
  coldSessionId: string;
  /**
   * Arms a REAL pending approval for the primary session through the production
   * `requestClientToolDecision`, with `requiresInteraction` taken from the same
   * `describeApprovalPolicy` the tools report. Resolves immediately (the wait
   * continues in the background); `settled` is the wait's own promise.
   */
  arm(spec: ArmSpec): { requestId: string; settled: Promise<unknown> };
  call(name: string, args?: AnyRecord, which?: TokenName): Promise<ToolCall>;
  /** The tool calls the real runtime resolver saw, in order. */
  resolveCalls: string[];
  resolveCountFor(requestId: string): number;
  /** The real ledger's record for a request id, or null. */
  readLedger(requestId: string): LedgerRecord | null;
  /** The real Turn Tracker's phase for a session. */
  phaseOf(sessionId: string): string;
  auditRows(): AuditRow[];
};

/**
 * Boots one arm: a fresh temp database, two real sessions, the real control
 * service over the real `providerRuntimeService` behind a counting shim, three
 * tokens, the real activity store, and the production `/mcp` mount carrying the
 * stage-3 read tools (so `session_get` / `sessions_list` / `overview` are real)
 * plus the stage-6 resident tools (so the two approval tools register).
 */
async function withHarness(label: string, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, `arm-${label}-`));
  const fixtureProject = path.join(tempDirectory, label);
  mkdirSync(fixtureProject, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'mcp-pending-interaction.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const primary = sessionsService.createAppSession('claude', fixtureProject, 'primary seed');
  const sessionId = primary.sessionId;
  const cold = sessionsService.createAppSession('claude', fixtureProject, 'cold seed');
  const coldSessionId = cold.sessionId;

  // The real runtime, with the one resolver counted. Every other verb is the
  // real service's own (readApprovalDecision included), so the ledger this
  // criterion reads back is the production ledger.
  const resolveCalls: string[] = [];
  const runtimeShim = {
    ...providerRuntimeService,
    resolveToolApproval(requestId: string, decision: unknown, decidedBy: string | null = null): void {
      resolveCalls.push(requestId);
      providerRuntimeService.resolveToolApproval(requestId, decision as never, decidedBy);
    },
  };
  const control = createChatControlService({
    runtime: runtimeShim as never,
    listApprovalSessionIds: () => [sessionId, coldSessionId],
  });

  const tokens = createAccessTokensService({ now: () => new Date() });
  const readToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'pending-read',
    scopes: [READ_SCOPE],
    expiresInDays: 30,
  });
  const readApproveToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'pending-read-approve',
    scopes: [READ_SCOPE, APPROVE_SCOPE],
    expiresInDays: 30,
  });
  const approveOnlyToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'pending-approve-only',
    scopes: [APPROVE_SCOPE],
    expiresInDays: 30,
  });
  if (!readToken.ok || !readApproveToken.ok || !approveOnlyToken.ok) {
    throw new Error('the harness must mint all three tokens');
  }

  // The real activity store, held for both sessions so a phase change is what
  // `overview` reads. The tracker itself is the production module-level one the
  // arm feeds, so no reader is injected here.
  const activityStore = createActivityStore({ now: () => NOW });
  activityStore.subscribe(sessionId, () => undefined);
  activityStore.subscribe(coldSessionId, () => undefined);

  const sessionRow = (id: string) => ({
    sessionId: id,
    provider: 'claude',
    projectId: null,
    sessionTitle: `title ${id}`,
    lastActivity: null,
  });

  const readDeps = {
    projects: {
      getProjectsWithSessions: async () => [],
      getArchivedProjectsWithSessions: async () => [],
      getProjectSessionsPage: async () => ({ projectId: '', sessions: [] }),
    },
    sessions: {
      listRecentSessions: () => ({
        conversations: [sessionRow(sessionId), sessionRow(coldSessionId)],
        total: 2,
      }),
      readSessionLifecycle: () => null,
      fetchHistory: async () => ({ messages: [], total: 0 }),
      fetchOutline: async () => ({ total: 0, turns: [] }),
      fetchWindowAround: async () => ({ messages: [], startIndex: 0, total: 0 }),
    },
    hosts: { snapshot: () => [], liveHostForSession: () => null },
    runs: { listRunningRuns: () => [], listRecentRuns: () => [] },
    quay: { hasQuayConfig: () => false, readCached: () => null, refresh: async () => null },
    activity: activityStore,
    // The SAME source `approvals_list` reads, so `pendingInteraction` /
    // `awaitingUser` cannot drift from the approval tools.
    approvals: {
      pendingForSession: (id: string) => providerRuntimeService.getPendingApprovalsForSession(id),
    },
    now: () => NOW,
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools: readDeps as never,
    residentTools: {
      control: control as never,
      approvals: { control: control as never, now: () => NOW },
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'pending-interaction-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect(readToken.token.token);
  const readApprove = await connect(readApproveToken.token.token);
  const approveOnly = await connect(approveOnlyToken.token.token);
  const clients: Record<TokenName, Client> = {
    read: read.client,
    readApprove: readApprove.client,
    approveOnly: approveOnly.client,
  };

  try {
    await run({
      sessionId,
      coldSessionId,
      arm(spec) {
        const settled = requestClientToolDecision({
          toolName: spec.toolName,
          input: spec.input,
          requiresInteraction: describeApprovalPolicy(spec.toolName).interactive,
          requestId: spec.requestId,
          ws: { send: () => undefined } as never,
          emitNotification: () => undefined,
          sessionId,
          sessionSummary: null,
        });
        // The wait continues in the background; the caller answers it. The
        // settled promise is surfaced so a leg can await cleanup.
        return { requestId: spec.requestId, settled: settled.then(() => undefined, () => undefined) };
      },
      async call(name, args = {}, which = 'read') {
        return parseToolResult(
          await clients[which].callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]),
        );
      },
      resolveCalls,
      resolveCountFor(requestId) {
        return resolveCalls.filter((id) => id === requestId).length;
      },
      readLedger(requestId) {
        return providerRuntimeService.readApprovalDecision(requestId);
      },
      phaseOf(id) {
        return activityStore.snapshot(id)?.turn.phase ?? 'unknown';
      },
      auditRows() {
        return getConnection()
          .prepare('SELECT id, tool, outcome, denied_scopes FROM mcp_audit_log ORDER BY id ASC')
          .all() as AuditRow[];
      },
    });
  } finally {
    await read.transport.close().catch(() => undefined);
    await readApprove.transport.close().catch(() => undefined);
    await approveOnly.transport.close().catch(() => undefined);
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

// --------------------------- fixtures ---------------------------

/** The `AskUserQuestion` input whose expansion legs (a) and (b) assert verbatim. */
function askInput(): AnyRecord {
  return {
    questions: [
      {
        question: '选哪个？',
        header: '选择',
        options: [
          { label: 'A', description: '甲' },
          { label: 'B', description: '乙' },
        ],
      },
    ],
  };
}

/** Reads the `approvals` array out of an `approvals_list` result. */
function approvalsOf(call: ToolCall): AnyRecord[] {
  return (call.payload?.approvals ?? []) as AnyRecord[];
}

/** Finds one approval entry by request id, asserting it is present. */
function entryFor(call: ToolCall, requestId: string): AnyRecord {
  const entry = approvalsOf(call).find((row) => row.requestId === requestId);
  assert.ok(entry, `approvals_list must carry ${requestId} (payload=${JSON.stringify(call.payload)})`);
  return entry;
}

/** Reads a session row out of a `sessions_list` result. */
function sessionRowOf(call: ToolCall, sessionId: string): AnyRecord {
  const rows = (call.payload?.sessions ?? []) as AnyRecord[];
  const row = rows.find((candidate) => candidate.id === sessionId);
  assert.ok(row, `sessions_list must carry ${sessionId} (payload=${JSON.stringify(call.payload)})`);
  return row;
}

// --------------------------- (a) visibility / AC3 ---------------------------

test('(a) session_get and sessions_list report a parked request, byte-identical to approvals_list', { concurrency: false }, async () => {
  await withHarness('visibility', async (harness) => {
    const armed = harness.arm({ toolName: 'AskUserQuestion', requestId: R_ASK_PARK, input: askInput() });

    const approvals = await harness.call('approvals_list', { session: harness.sessionId });
    const entry = entryFor(approvals, R_ASK_PARK);

    const detail = await harness.call('session_get', { session: harness.sessionId });
    const interaction = detail.payload?.pendingInteraction as AnyRecord | null;
    const listing = await harness.call('sessions_list', {});
    const parkedRow = sessionRowOf(listing, harness.sessionId);

    const coldDetail = await harness.call('session_get', { session: harness.coldSessionId });
    const coldRow = sessionRowOf(listing, harness.coldSessionId);

    say(`(a) approvals_list entry=${JSON.stringify(entry)}`);
    say(`(a) session_get pendingInteraction=${JSON.stringify(interaction)}`);
    say(`(a) sessions_list parked row awaitingUser=${String(parkedRow.awaitingUser)}`);
    say(`(a) cold session_get pendingInteraction=${JSON.stringify(coldDetail.payload?.pendingInteraction ?? null)} awaitingUser=${String(coldRow.awaitingUser)}`);

    assert.equal(detail.isError, false, `session_get must not error (text=${detail.text})`);
    assert.ok(interaction, 'a session parked on AskUserQuestion must read a non-null pendingInteraction');
    assert.equal(interaction.requestId, entry.requestId, 'the two surfaces must name one request id');
    assert.equal(interaction.toolName, entry.toolName, 'the two surfaces must name one tool');
    assert.deepEqual(interaction.questions, entry.questions, 'the two surfaces must expand the same questions');
    assert.deepEqual(interaction.questions, [
      {
        question: '选哪个？',
        header: '选择',
        options: [
          { label: 'A', description: '甲' },
          { label: 'B', description: '乙' },
        ],
      },
    ], 'the expansion is the request input, verbatim');
    assert.equal(parkedRow.awaitingUser, true, 'the parked session reads awaitingUser');

    // The positive control: a clean session is not reported as parked by either.
    assert.equal(coldDetail.payload?.pendingInteraction ?? null, null, 'the clean session reads no pending interaction');
    assert.equal(coldRow.awaitingUser, false, 'the clean session reads awaitingUser false');

    // The park really is the live phase, not a fixture: answering it leaves it.
    const answered = await harness.call('approval_answer', { requestId: R_ASK_PARK, allow: true }, 'readApprove');
    assert.equal(answered.isError, false, `answering the parked request must succeed (text=${answered.text})`);
    await armed.settled;
    say(`(a) after answer phase=${harness.phaseOf(harness.sessionId)} resolveCount=${harness.resolveCountFor(R_ASK_PARK)}`);
    assert.equal(harness.resolveCountFor(R_ASK_PARK), 1, 'the answer must reach the real resolver exactly once');
  });
});

// --------------------------- (b) policy / AC4 ---------------------------

test('(b) interactive vs auto-denying requests are distinguished from the real policy', { concurrency: false }, async () => {
  await withHarness('policy', async (harness) => {
    const bash = harness.arm({ toolName: 'Bash', requestId: R_BASH, input: { command: 'echo hi' } });
    const bashList = await harness.call('approvals_list', { session: harness.sessionId });
    const bashEntry = entryFor(bashList, R_BASH);
    const bashDetail = await harness.call('session_get', { session: harness.sessionId });
    const bashInteraction = bashDetail.payload?.pendingInteraction as AnyRecord | null;
    say(`(b) Bash pendingInteraction=${JSON.stringify(bashInteraction)} approvals_list entry=${JSON.stringify(bashEntry)}`);
    assert.ok(bashInteraction, 'a parked Bash must read a pendingInteraction');
    assert.equal(bashInteraction.interactive, false, 'an ordinary permission is not interactive');
    assert.equal(bashInteraction.autoTimeoutMs, TOOL_APPROVAL_TIMEOUT_MS, 'it auto-denies at the injected deadline');
    assert.equal(TOOL_APPROVAL_TIMEOUT_MS, INJECTED_TIMEOUT_MS, 'the deadline must be the injected value, not the default');
    assert.equal(bashEntry.interactive, false, 'approvals_list agrees on interactive');
    assert.equal(bashEntry.autoTimeoutMs, TOOL_APPROVAL_TIMEOUT_MS, 'approvals_list agrees on the deadline');
    await harness.call('approval_answer', { requestId: R_BASH, allow: true }, 'readApprove');
    await bash.settled;

    for (const [requestId, toolName] of [[R_ASK_POLICY, 'AskUserQuestion'], [R_PLAN, 'ExitPlanMode']] as const) {
      const armed = harness.arm({ toolName, requestId, input: toolName === 'AskUserQuestion' ? askInput() : { plan: 'ship it' } });
      const detail = await harness.call('session_get', { session: harness.sessionId });
      const interaction = detail.payload?.pendingInteraction as AnyRecord | null;
      const list = await harness.call('approvals_list', { session: harness.sessionId });
      const entry = entryFor(list, requestId);
      say(`(b) ${toolName} pendingInteraction=${JSON.stringify(interaction)} approvals_list entry=${JSON.stringify(entry)}`);
      assert.ok(interaction, `${toolName} must read a pendingInteraction`);
      assert.equal(interaction.interactive, true, `${toolName} is an interactive request`);
      assert.equal(interaction.autoTimeoutMs, null, `${toolName} waits indefinitely — no auto-deny deadline`);
      assert.equal(entry.interactive, true, `approvals_list agrees ${toolName} is interactive`);
      assert.equal(entry.autoTimeoutMs, null, `approvals_list agrees ${toolName} has no deadline`);
      await harness.call('approval_answer', { requestId, allow: true }, 'readApprove');
      await armed.settled;
    }
  });
});

// --------------------------- (c) race / AC5 ---------------------------

test('(c) two concurrent answers settle once; the loser reads ALREADY_DECIDED', { concurrency: false }, async () => {
  await withHarness('race', async (harness) => {
    const armed = harness.arm({ toolName: 'ExitPlanMode', requestId: R_RACE, input: { plan: 'race' } });

    const [allowCall, denyCall] = await Promise.all([
      harness.call('approval_answer', { requestId: R_RACE, allow: true }, 'readApprove'),
      harness.call('approval_answer', { requestId: R_RACE, allow: false }, 'readApprove'),
    ]);

    say(`(c) allow-call isError=${allowCall.isError} payload=${JSON.stringify(allowCall.payload)}`);
    say(`(c) deny-call isError=${denyCall.isError} payload=${JSON.stringify(denyCall.payload)}`);
    say(`(c) resolveCount=${harness.resolveCountFor(R_RACE)} ledger=${JSON.stringify(harness.readLedger(R_RACE))}`);

    const calls = [allowCall, denyCall];
    const winners = calls.filter((call) => call.isError === false);
    const losers = calls.filter((call) => call.isError === true);
    assert.equal(winners.length, 1, 'exactly one concurrent answer may win');
    assert.equal(losers.length, 1, 'exactly one concurrent answer must lose');
    assert.equal(harness.resolveCountFor(R_RACE), 1, 'the real resolver must be called exactly once');

    const loser = losers[0] as ToolCall;
    assert.equal(loser.payload?.code, 'ALREADY_DECIDED', 'the loser must read the forwarded ALREADY_DECIDED code, not APPROVAL_NOT_FOUND');
    const details = (loser.payload?.details ?? {}) as AnyRecord;
    assert.equal(details.decidedBy, String(USER_ONE), 'the loser learns which caller won');
    assert.equal(typeof details.decidedAt, 'number', 'the loser learns when the winner decided');
    const ledger = harness.readLedger(R_RACE);
    assert.ok(ledger, 'the winner must leave a ledger record');
    assert.equal(details.decidedAt, ledger.decidedAt, 'the reported instant is the ledger record itself');

    await armed.settled;
    say(`(c) after race phase=${harness.phaseOf(harness.sessionId)}`);
  });
});

// --------------------------- (d) scope + ledger / AC7 ---------------------------

test('(d) only an approve-scoped caller writes a ledger record; a read-only call is denied and audited', { concurrency: false }, async () => {
  await withHarness('scope', async (harness) => {
    const armed = harness.arm({ toolName: 'ExitPlanMode', requestId: R_SCOPE, input: { plan: 'scope' } });

    // (i) read-only token: the new READ fields are visible, the write is not.
    const readDetail = await harness.call('session_get', { session: harness.sessionId }, 'read');
    const readList = await harness.call('approvals_list', { session: harness.sessionId }, 'read');
    const denied = await harness.call('approval_answer', { requestId: R_SCOPE, allow: true }, 'read');
    say(`(d) read-only session_get awaitingUser=${String((readDetail.payload?.session as AnyRecord | undefined)?.awaitingUser)} approvals=${approvalsOf(readList).length}`);
    say(`(d) read-only approval_answer isError=${denied.isError} payload=${JSON.stringify(denied.payload)}`);
    say(`(d) ledger after denied answer=${JSON.stringify(harness.readLedger(R_SCOPE))} resolveCount=${harness.resolveCountFor(R_SCOPE)}`);
    assert.equal(readDetail.isError, false, 'a read token carries the new session_get fields');
    assert.equal(readList.isError, false, 'a read token carries the new approvals_list fields');
    assert.equal(denied.isError, true, 'a read-only token may not answer an approval');
    assert.equal(harness.readLedger(R_SCOPE), null, 'a refused answer writes no ledger record');
    assert.equal(harness.resolveCountFor(R_SCOPE), 0, 'a refused answer never reaches the resolver');

    const deniedRows = harness.auditRows().filter((row) => row.outcome === 'denied');
    say(`(d) denied audit rows=${JSON.stringify(deniedRows)}`);
    assert.equal(deniedRows.length, 1, 'the refusal must leave exactly one denied audit row');
    assert.equal(deniedRows[0].tool, 'approval_answer', 'the denied row names the tool that was refused');

    // (ii) approve-only token: it may answer, but it may not read the session.
    const approveOnlyRead = await harness.call('session_get', { session: harness.sessionId }, 'approveOnly');
    const approved = await harness.call('approval_answer', { requestId: R_SCOPE, allow: true }, 'approveOnly');
    say(`(d) approve-only session_get isError=${approveOnlyRead.isError} payload=${JSON.stringify(approveOnlyRead.payload)}`);
    say(`(d) approve-only approval_answer isError=${approved.isError} payload=${JSON.stringify(approved.payload)}`);
    assert.equal(approveOnlyRead.isError, true, 'the approve scope alone does not read a session');
    assert.equal(approved.isError, false, 'the approve scope may answer');
    await armed.settled;

    // (iii) the ledger is what a SECOND answer reads back.
    const ledger = harness.readLedger(R_SCOPE);
    const second = await harness.call('approval_answer', { requestId: R_SCOPE, allow: false }, 'readApprove');
    say(`(d) ledger after approved answer=${JSON.stringify(ledger)} second answer payload=${JSON.stringify(second.payload)}`);
    assert.ok(ledger, 'the approved answer writes the ledger record');
    assert.equal(ledger.decidedBy, String(USER_ONE), 'the ledger names the winning caller');
    assert.equal(ledger.allow, true, 'the ledger records the winner decision');
    assert.equal(second.isError, true, 'a repeat answer is refused');
    assert.equal(second.payload?.code, 'ALREADY_DECIDED', 'the repeat reads the ledger, not APPROVAL_NOT_FOUND');
    assert.equal(harness.resolveCountFor(R_SCOPE), 1, 'the resolver was reached exactly once across all three callers');
  });
});

// --------------------------- (e) alignment / AC8 ---------------------------

test('(e) the default approvals scan and overview awaitingPermission name the same sessions', { concurrency: false }, async () => {
  await withHarness('align', async (harness) => {
    const armed = harness.arm({ toolName: 'AskUserQuestion', requestId: R_ALIGN, input: askInput() });

    async function listedSessions(): Promise<string[]> {
      const call = await harness.call('approvals_list', {});
      const approvals = approvalsOf(call);
      return [...new Set(approvals.map((entry) => String(entry.session)))].sort();
    }
    async function awaitingSessions(): Promise<string[]> {
      const call = await harness.call('overview', {});
      const rows = (call.payload?.awaitingPermission ?? []) as Array<{ sessionId: string }>;
      return [...new Set(rows.map((row) => row.sessionId))].sort();
    }

    const listed = await listedSessions();
    const awaiting = await awaitingSessions();
    say(`(e) approvals_list sessions=${JSON.stringify(listed)}`);
    say(`(e) overview awaitingPermission=${JSON.stringify(awaiting)}`);
    say(`(e) phase(primary)=${harness.phaseOf(harness.sessionId)} phase(cold)=${harness.phaseOf(harness.coldSessionId)}`);

    assert.deepEqual(listed, [harness.sessionId], 'the pending scan names the parked session');
    assert.deepEqual(awaiting, [harness.sessionId], 'the overview names the same session');
    assert.deepEqual(listed, awaiting, 'the two scans agree');
    assert.ok(!listed.includes(harness.coldSessionId), 'the clean session is in neither scan');

    await harness.call('approval_answer', { requestId: R_ALIGN, allow: true }, 'readApprove');
    await armed.settled;
  });
});
