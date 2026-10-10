/**
 * Criterion: the debug agent can raise a HUMAN-FACING popup, and the MCP approval
 * loop — "the prompt is visible" → `approval_answer` → "the walk resumes" —
 * closes on a debug session without a real model, a real `claude` binary or the
 * real 55s approval deadline.
 *
 * The gap this criterion closes: `gap-mcp-pending-interaction-visibility-and-idempotent-answer`
 * already drove a REAL claude runtime through the MCP tools, but it armed the
 * park by calling `requestClientToolDecision` directly — a seam-level park with
 * no turn behind it to RESUME. The debug agent's runtime carried only
 * `run/abort/stopTask/backgroundTask`, so `providerRuntimeService.getPendingApprovalsForSession`
 * (which is `provider.runtime.permissions?.listPending(...) ?? []`) was always
 * `[]` for it and no `tool-call` step could park a session on a person. This
 * criterion reads the fix at the agent's OWN seam: a scenario step raises the
 * prompt, the runtime's own pending table answers the read, and the step after
 * the prompt lands only once the prompt is answered.
 *
 * Readings, one leg each:
 *   (a) VISIBILITY / AC3 — a scenario parked on a `permission-request` step for
 *       `AskUserQuestion`: `session_get(session).pendingInteraction` is non-null
 *       and its `requestId` / `toolName` / `questions` are byte-identical to the
 *       `approvals_list({session})` entry for the same request; the `questions`
 *       expansion carries every option verbatim; and `approvals_list({})`'s
 *       pending-session set equals `overview()`'s `awaitingPermission` set, with
 *       the debug session in BOTH — the alignment that also proves the injected
 *       announcer fed the Turn Tracker, not just the frame.
 *   (b) RESUME / AC4 — after `approval_answer({requestId, allow:true, answers})`:
 *       (i) the transcript row count GROWS by exactly the one `row` step behind
 *       the prompt, read once while parked and once after the answer, so the
 *       increment is attributable to the answer rather than to the scenario
 *       having written it up front; (ii) `session_get.pendingInteraction` is back
 *       to `null`; (iii) `overview` no longer names the session in
 *       `awaitingPermission`.
 *   (c) IDEMPOTENCE + MISSING / AC5 — a second answer for the same id reads
 *       `ALREADY_DECIDED` with `decidedBy` / `decidedAt` (NOT
 *       `APPROVAL_NOT_FOUND`); a `requestId` the scenario raised and then
 *       DROPPED (`hold:false`) reads `expired` (`details.reason` verbatim); a
 *       `requestId` nothing ever minted reads `never_issued`.
 *
 * ## What is real
 *
 * The debug agent is the real one the registry builds (`DEBUG_AGENT=on` +
 * `DEBUG_AGENT_HOME` set before any aliased import), driven through the product's
 * own dispatch (`providerRuntimeService.run`), so `trackPerRunTurn` wraps the
 * writer and the provider's own `sessions` face is the normalizer. A real express
 * application carries the production `/mcp` mount behind the production token
 * middleware, and the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`. The control service is the real
 * `createChatControlService` over the real `providerRuntimeService`, and the
 * activity store is the real `createActivityStore`, so `overview`'s
 * `awaitingPermission` is the real Turn Tracker's phase and not a stub's.
 *
 * Every request id is namespaced by the arm's label: the runtime's ledgers are a
 * process-lifetime singleton (as claude's are), so two arms that reused a literal
 * id would read each other's decisions. The session ids are minted per arm and the
 * arm's stubs (`listRecentSessions`, `listApprovalSessionIds`) name only their own
 * sessions, so no arm can observe another's park.
 *
 * The `node:http`-based `fetch` is required for the same reason the MCP criteria
 * document: `listen(0)` on this host lands on a port undici refuses often enough
 * to red a suite run at random.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

// --------------------------------------------------------------------------
// A scratch HOME, a fixture home for the debug agent's transcripts, and the
// debug gate are all set BEFORE any aliased module is imported: the gate is read
// once per process and cached, so an arm cannot open it later. The fixture home
// is shared by every arm (the gate is process-lifetime), but each arm's
// transcript path contains its own minted session id, so the arms never collide.
// --------------------------------------------------------------------------
//
// The two gate variables are spelled through constants so this file never becomes
// a second reader of them: the gate criterion asserts that, outside the gate
// module, `server/` contains no direct read of either, and this file must pass
// that check.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'debug-agent-permission-popup-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'debug-agent-permission-popup-test-secret';
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { providerRegistry, providerRuntimeService } = await import('@/modules/providers/index.js');
const { createActivityStore, createChatControlService } = await import('@/modules/websocket/index.js');
const { MCP_GATEWAY_PATH, createMcpAuthMiddleware, mountMcpGateway } = await import(
  '@/modules/mcp-gateway/index.js'
);
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario } = await import('../index.js');
const { readTranscriptRows } = await import('../debug-agent.runtime.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const READ_SCOPE = 'cloudcli:read';
const APPROVE_SCOPE = 'cloudcli:approve';
/** The instant every relative reading is measured against. */
const NOW = Date.now();
/** How long a leg waits for the walk to park before it reds. */
const PARK_TIMEOUT_MS = 8000;

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`debug-agent-permission-popup ${line}`);
}

/** Namespaces a request id by the arm that raised it — see the file header. */
function rid(label: string, name: string): string {
  return `${label}-${name}`;
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
  // into the text; a SUCCESS payload is still the text body.
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

/** The `AskUserQuestion` input whose expansion legs (a) assert verbatim. */
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

/** The expansion `approvals_list` / `session_get` must report for {@link askInput}. */
const ASK_EXPANSION = [
  {
    question: '选哪个？',
    header: '选择',
    options: [
      { label: 'A', description: '甲' },
      { label: 'B', description: '乙' },
    ],
  },
];

// --------------------------- the debug scenario ---------------------------

type Step = Record<string, unknown>;

/**
 * The scenario one arm drives. A `permission-request` step is the debug agent's
 * own popup; the `row` behind it is what a resume leaves on disk. `hold` defaults
 * to true in the loader, so a plain step parks the walk.
 */
function scenarioOf(steps: Step[], mustContain: string[]): unknown {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: 'debug agent permission popup', userText: 'please ask me something' },
    steps,
    expect: { rows: { delta: 1 }, content: { mustContain } },
  };
}

// --------------------------- the harness ---------------------------

type TokenName = 'read' | 'readApprove';

type Harness = {
  sessionId: string;
  transcriptPath: string;
  /** Frames the run's writer saw, in order — the announcer's own output. */
  frames: AnyRecord[];
  /** The dispatched run's outcome; resolves only once the walk finishes. */
  settled: Promise<{ ok: true } | { ok: false; error: unknown }>;
  call(name: string, args?: AnyRecord, which?: TokenName): Promise<ToolCall>;
  /** The real Turn Tracker's phase for the session, via the activity store. */
  phaseOf(sessionId: string): string;
  /** The session's transcript rows on disk, right now. */
  rows(): AnyRecord[];
  /** Waits until the runtime's own pending table is non-empty for the session. */
  waitForPark(): Promise<void>;
};

/**
 * Boots one arm: a fresh temp database, a REAL debug session armed from a scenario
 * and indexed, the real control service over the real `providerRuntimeService`, the
 * real activity store held for the session, two tokens, and the production `/mcp`
 * mount carrying the read tools plus the two approval tools.
 */
async function withHarness(
  label: string,
  scenario: unknown,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, `arm-${label}-`));
  const projectPath = path.join(tempDirectory, 'workspace');
  mkdirSync(projectPath, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'debug-agent-permission-popup.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  // The REAL provider the registry built — its `permissions` face is what this
  // criterion is about, so it is never replaced by a stand-in.
  const provider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
  const armed = await armDebugAgentScenario({
    projectPath,
    scenario,
    synchronizeTranscript: (filePath) => provider.sessionSynchronizer.synchronizeFile(filePath),
  });
  const sessionId = armed.sessionId;

  // The real activity store, held for this session so a phase change is what
  // `overview` reads back. The tracker itself is the production module-level one
  // the announcer feeds, so no reader is injected here.
  const activityStore = createActivityStore({ now: () => NOW });
  activityStore.subscribe(sessionId, () => undefined);

  const control = createChatControlService({
    runtime: providerRuntimeService as never,
    listApprovalSessionIds: () => [sessionId],
  });

  const tokens = createAccessTokensService({ now: () => new Date() });
  const readToken = tokens.issueToken({
    userId: USER_ONE,
    name: `popup-read-${label}`,
    scopes: [READ_SCOPE],
    expiresInDays: 30,
  });
  const readApproveToken = tokens.issueToken({
    userId: USER_ONE,
    name: `popup-read-approve-${label}`,
    scopes: [READ_SCOPE, APPROVE_SCOPE],
    expiresInDays: 30,
  });
  if (!readToken.ok || !readApproveToken.ok) {
    throw new Error('the harness must mint both tokens');
  }

  const sessionRow = (id: string) => ({
    sessionId: id,
    provider: DEBUG_AGENT_PROVIDER_ID,
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
      listRecentSessions: () => ({ conversations: [sessionRow(sessionId)], total: 1 }),
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
    const client = new Client({ name: 'debug-popup-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect(readToken.token.token);
  const readApprove = await connect(readApproveToken.token.token);
  const clients: Record<TokenName, Client> = { read: read.client, readApprove: readApprove.client };

  // The run is dispatched but NOT awaited: the walk parks on the popup, and the
  // legs below read the parked state before answering it. Frames land on a plain
  // writer — `trackPerRunTurn` wraps it and hands it straight to the runtime, so
  // what arrives is the product's own frame objects.
  const frames: AnyRecord[] = [];
  const writer = {
    send: (data: unknown): void => {
      frames.push(data as AnyRecord);
    },
  };
  const runPromise = providerRuntimeService
    .run(
      DEBUG_AGENT_PROVIDER_ID as never,
      'debug agent scenario',
      { sessionId, cwd: armed.projectPath, projectPath: armed.projectPath },
      writer as never,
    )
    .then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );

  try {
    await run({
      sessionId,
      transcriptPath: armed.transcriptPath,
      frames,
      settled: runPromise,
      async call(name, args = {}, which = 'read') {
        return parseToolResult(
          await clients[which].callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]),
        );
      },
      phaseOf(id) {
        return activityStore.snapshot(id)?.turn.phase ?? 'unknown';
      },
      rows() {
        return readTranscriptRows(armed.transcriptPath);
      },
      async waitForPark() {
        const deadline = Date.now() + PARK_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (providerRuntimeService.getPendingApprovalsForSession(sessionId).length > 0) {
            return;
          }
          await delay(10);
        }
        throw new Error(`the debug popup never parked for ${sessionId}`);
      },
    });
  } finally {
    await read.transport.close().catch(() => undefined);
    await readApprove.transport.close().catch(() => undefined);
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

// --------------------------- (a) visibility / AC3 ---------------------------

test('(a) a debug popup is visible on session_get, approvals_list and overview', { concurrency: false }, async () => {
  const label = 'a';
  const R_ASK = rid(label, 'ask');
  await withHarness(
    label,
    scenarioOf(
      [
        { at: 10, op: 'permission-request', toolName: 'AskUserQuestion', input: askInput(), requestId: R_ASK },
        { at: 20, op: 'row', role: 'assistant', text: 'visible then answered' },
      ],
      ['visible then answered'],
    ),
    async (h) => {
      await h.waitForPark();

      // The announcer's own output: a frame the debug module may not spell but
      // the injected seam must emit.
      const frameKinds = [...new Set(h.frames.map((frame) => frame.kind))];
      const popupFrame = h.frames.find((frame) => frame.kind === 'permission_request');
      say(`(a) frame kinds=${JSON.stringify(frameKinds)}`);
      say(`(a) permission_request frame=${JSON.stringify(popupFrame)}`);
      assert.ok(popupFrame, 'the injected announcer must emit the prompt frame');
      assert.equal(popupFrame.requestId, R_ASK, 'the frame names the request the scenario minted');

      const approvals = await h.call('approvals_list', { session: h.sessionId });
      const entry = entryFor(approvals, R_ASK);
      const detail = await h.call('session_get', { session: h.sessionId });
      const interaction = detail.payload?.pendingInteraction as AnyRecord | null;

      const allApprovals = await h.call('approvals_list', {});
      const listedSessions = [...new Set(approvalsOf(allApprovals).map((row) => String(row.session)))].sort();
      const overview = await h.call('overview', {});
      const awaiting = ((overview.payload?.awaitingPermission ?? []) as Array<{ sessionId: string }>)
        .map((row) => row.sessionId)
        .sort();

      say(`(a) approvals_list entry=${JSON.stringify(entry)}`);
      say(`(a) session_get pendingInteraction=${JSON.stringify(interaction)}`);
      say(`(a) approvals_list({}) sessions=${JSON.stringify(listedSessions)}`);
      say(`(a) overview awaitingPermission=${JSON.stringify(awaiting)}`);
      say(`(a) phase=${h.phaseOf(h.sessionId)}`);

      assert.equal(detail.isError, false, `session_get must not error (text=${detail.text})`);
      assert.ok(interaction, 'a session parked on a debug popup must read a non-null pendingInteraction');
      assert.equal(interaction.requestId, entry.requestId, 'the two surfaces must name one request id');
      assert.equal(interaction.toolName, entry.toolName, 'the two surfaces must name one tool');
      assert.deepEqual(interaction.questions, entry.questions, 'the two surfaces must expand the same questions');
      assert.deepEqual(interaction.questions, ASK_EXPANSION, 'the expansion is the request input, verbatim');
      assert.equal(h.phaseOf(h.sessionId), 'awaitingPermission', 'the announcer must also feed the Turn Tracker');

      // The alignment the task calls out: the pending scan and the overview name
      // the same sessions, and the debug session is in BOTH.
      assert.deepEqual(listedSessions, [h.sessionId], 'the pending scan names the parked debug session');
      assert.deepEqual(awaiting, [h.sessionId], 'the overview names the same session');
      assert.deepEqual(listedSessions, awaiting, 'the two scans agree');

      // Leave the walk un-parked so the arm's run settles cleanly.
      const answered = await h.call('approval_answer', { requestId: R_ASK, allow: true }, 'readApprove');
      assert.equal(answered.isError, false, `answering the parked request must succeed (text=${answered.text})`);
      const outcome = await h.settled;
      assert.equal(outcome.ok, true, `the run must finish (error=${JSON.stringify((outcome as { error?: unknown }).error)})`);
    },
  );
});

// --------------------------- (b) resume / AC4 ---------------------------

test('(b) answering the popup resumes the walk and clears the park', { concurrency: false }, async () => {
  const label = 'b';
  const R_ASK = rid(label, 'ask');
  const RESUME_TEXT = 'the walk continued after the answer';
  await withHarness(
    label,
    scenarioOf(
      [
        { at: 10, op: 'permission-request', toolName: 'AskUserQuestion', input: askInput(), requestId: R_ASK },
        { at: 20, op: 'row', role: 'assistant', text: RESUME_TEXT },
      ],
      [RESUME_TEXT],
    ),
    async (h) => {
      await h.waitForPark();

      // The "before" reading: the prompt is parked and the row behind it is NOT
      // on disk yet, so the increment measured below is attributable to the
      // answer rather than to the scenario writing everything up front.
      const rowsWhileParked = h.rows();
      const parkedInteraction = (await h.call('session_get', { session: h.sessionId })).payload?.pendingInteraction;
      say(`(b) rows while parked=${rowsWhileParked.length} pendingInteraction=${JSON.stringify(parkedInteraction)}`);
      assert.ok(parkedInteraction, 'the session is parked before the answer');
      const parkedRowCount = rowsWhileParked.length;

      const answered = await h.call(
        'approval_answer',
        { requestId: R_ASK, allow: true, answers: { answer: 'A' } },
        'readApprove',
      );
      assert.equal(answered.isError, false, `approval_answer must succeed (text=${answered.text})`);
      const outcome = await h.settled;
      assert.equal(outcome.ok, true, `the run must finish (error=${JSON.stringify((outcome as { error?: unknown }).error)})`);

      const rowsAfter = h.rows();
      const resumeRow = rowsAfter.at(-1) as AnyRecord | undefined;
      const resumeText = ((resumeRow?.message as AnyRecord | undefined)?.content as AnyRecord[] | undefined)?.[0]?.text;
      say(`(b) rows after answer=${rowsAfter.length} (parked=${parkedRowCount})`);
      say(`(b) resume row uuid=${JSON.stringify(resumeRow?.uuid)} text=${JSON.stringify(resumeText)}`);

      // (i) the row count grew by exactly the one step behind the prompt, and the
      // row that landed is that step's row — verbatim uuid and content.
      assert.equal(rowsAfter.length, parkedRowCount + 1, 'exactly one row lands after the answer');
      assert.equal(resumeText, RESUME_TEXT, 'the row that landed is the scenario step behind the prompt');
      const resumeUuidValue = resumeRow?.uuid;
      const resumeUuid = typeof resumeUuidValue === 'string' ? resumeUuidValue : '';
      assert.ok(resumeUuid.length > 0, 'the resumed row carries a non-empty uuid');

      // (ii) the park is gone from the session reading.
      const afterDetail = await h.call('session_get', { session: h.sessionId });
      say(`(b) after session_get pendingInteraction=${JSON.stringify(afterDetail.payload?.pendingInteraction ?? null)} phase=${h.phaseOf(h.sessionId)}`);
      assert.equal(afterDetail.payload?.pendingInteraction ?? null, null, 'the answered session reads no pending interaction');

      // (iii) the overview no longer names the session.
      const overview = await h.call('overview', {});
      const awaiting = ((overview.payload?.awaitingPermission ?? []) as Array<{ sessionId: string }>).map(
        (row) => row.sessionId,
      );
      say(`(b) after overview awaitingPermission=${JSON.stringify(awaiting)}`);
      assert.ok(!awaiting.includes(h.sessionId), 'an answered session must leave the overview awaiting set');
    },
  );
});

// --------------------------- (c) idempotence + missing / AC5 ---------------------------

test('(c) a repeat answer reads ALREADY_DECIDED, a dropped request expired, an unknown id never_issued', { concurrency: false }, async () => {
  const label = 'c';
  const R_HOLD = rid(label, 'hold');
  const R_DROP = rid(label, 'drop');
  const R_UNKNOWN = rid(label, 'never-issued');
  await withHarness(
    label,
    scenarioOf(
      [
        { at: 10, op: 'permission-request', toolName: 'ExitPlanMode', input: { plan: 'ship it' }, requestId: R_HOLD },
        // Raised and immediately dropped — the shape of a prompt that timed out.
        { at: 12, op: 'permission-request', toolName: 'Bash', input: { command: 'echo hi' }, requestId: R_DROP, hold: false },
        { at: 20, op: 'row', role: 'assistant', text: 'resumed after the held plan' },
      ],
      ['resumed after the held plan'],
    ),
    async (h) => {
      await h.waitForPark();

      const first = await h.call('approval_answer', { requestId: R_HOLD, allow: true }, 'readApprove');
      assert.equal(first.isError, false, `the first answer must succeed (text=${first.text})`);
      const outcome = await h.settled;
      assert.equal(outcome.ok, true, `the run must finish (error=${JSON.stringify((outcome as { error?: unknown }).error)})`);

      // (i) the same id answered again: the ledger answers, not the pending set.
      const repeat = await h.call('approval_answer', { requestId: R_HOLD, allow: false }, 'readApprove');
      const repeatDetails = (repeat.payload?.details ?? {}) as AnyRecord;
      say(`(c) repeat answer isError=${repeat.isError} code=${JSON.stringify(repeat.payload?.code)} details=${JSON.stringify(repeatDetails)}`);
      assert.equal(repeat.isError, true, 'a repeat answer is refused');
      assert.equal(repeat.payload?.code, 'ALREADY_DECIDED', 'the repeat reads the ledger, not APPROVAL_NOT_FOUND');
      assert.equal(repeatDetails.decidedBy, String(USER_ONE), 'the loser learns which caller won');
      assert.equal(typeof repeatDetails.decidedAt, 'number', 'the loser learns when the winner decided');

      // (ii) an id the scenario raised and dropped reads `expired`.
      const dropped = await h.call('approval_answer', { requestId: R_DROP, allow: true }, 'readApprove');
      const droppedDetails = (dropped.payload?.details ?? {}) as AnyRecord;
      say(`(c) dropped request isError=${dropped.isError} code=${JSON.stringify(dropped.payload?.code)} reason=${JSON.stringify(droppedDetails.reason)}`);
      assert.equal(dropped.isError, true, 'a dropped request is refused');
      assert.equal(dropped.payload?.code, 'APPROVAL_NOT_FOUND', 'it is the expired/unknown envelope');
      assert.equal(droppedDetails.reason, 'expired', 'a raised-then-dropped id classifies as expired');

      // (iii) an id nothing ever minted reads `never_issued`.
      const unknown = await h.call('approval_answer', { requestId: R_UNKNOWN, allow: true }, 'readApprove');
      const unknownDetails = (unknown.payload?.details ?? {}) as AnyRecord;
      say(`(c) unknown id isError=${unknown.isError} code=${JSON.stringify(unknown.payload?.code)} reason=${JSON.stringify(unknownDetails.reason)}`);
      assert.equal(unknown.isError, true, 'an unknown id is refused');
      assert.equal(unknown.payload?.code, 'APPROVAL_NOT_FOUND', 'it is the expired/unknown envelope');
      assert.equal(unknownDetails.reason, 'never_issued', 'an id nothing minted classifies as never_issued');
    },
  );
});
