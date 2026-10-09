/**
 * AC-310's positive criteria, over FAKE gateway services.
 *
 * The live executor's whole claim is "a voice function call reaches the REAL
 * send path, and the session it may act on is pinned by a parameter whitelist
 * rather than by a new approval layer". Three readings, one per criterion:
 *
 *  - AC1 — all six tool routes land on the MCP gateway's OWN build function for
 *    that tool, with the arguments passed through unchanged. Proven by DELEGATION
 *    rather than by a hand-written expectation: the executor is driven over one
 *    fake service set, the matching `build*` function is called directly over a
 *    second identical set, and the two must agree on BOTH the returned value AND
 *    the recorded seam interactions — a second copy of the logic would have to
 *    reproduce the gateway's exact call pattern to pass, and the non-empty log
 *    rules out a route that answers without reaching any service at all.
 *  - AC2 — a `session_send` reaches the control seam with a caller recorded as
 *    `via: 'mcp'`, and the returned payload reports the `mcp` source.
 *  - AC3 — a function call naming a session OTHER than the bound one is refused
 *    AND recorded, and never reaches the other session's send.
 *
 * The fakes are the same shape `server/index.ts` injects in production (the
 * gateway's own deps bags), so the code under test is the shipping code, not a
 * test-only branch.
 *
 * Consumers: the quay worker's AC state for AC-310; the false-forms file beside
 * it proves these readings can go red.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildApprovalsList,
  buildRunGet,
  buildSessionBackground,
  buildSessionDetail,
  buildSessionSend,
  buildUiVisibleContext,
  type McpApprovalsDeps,
  type McpApprovalsListInput,
  type McpPrincipal,
  type McpReadToolDeps,
  type McpRunGetDeps,
  type McpRunGetInput,
  type McpSessionBackgroundDeps,
  type McpSessionBackgroundInput,
  type McpSessionSendDeps,
  type McpUiVisibleContextDeps,
  type McpUiVisibleContextInput,
} from '@/modules/mcp-gateway/index.js';

import {
  VoiceRealtimeSessionRefusalError,
  createVoiceRealtimeLiveExecutor,
  type RealtimeToolExecutor,
  type VoiceRealtimeSessionRefusal,
} from '../index.js';

// ── the fixture constants ────────────────────────────────────────────────────────────────────

/** The clock every fake reads, so a `now()`-derived field is the same on both paths. */
const NOW = 1_700_000_000_000;
/** The bound session every executor under test may act on. */
const BOUND_SESSION = 'sess-bound';
/** The first-party user the connection acts as. */
const USER_ID = 7;
/** The scope the connection carries (used by the gateway's own scope checks). */
const SCOPE = 'cloudcli:read';

/** One interaction a fake service recorded, so the two paths' call patterns can be compared. */
type Call = { seam: string; args: unknown[] };

/** The six gateway service bags the executor is built over, plus this fake's interaction log. */
type FakeGateway = {
  calls: Call[];
  visibleContext: McpUiVisibleContextDeps;
  readTools: McpReadToolDeps;
  runGet: McpRunGetDeps;
  approvals: McpApprovalsDeps;
  sessionBackground: McpSessionBackgroundDeps;
  sessionSend: McpSessionSendDeps;
};

/**
 * Builds one fake gateway service set.
 *
 * Every service answers a deterministic reading (an empty device list, a single
 * known session, a null host, a successful send) and RECORDS the call, so two
 * independent instances produce both the same values and the same log unless the
 * code driving them differs. The casts are because these are structural fakes of
 * the gateway's own deps bags: only the members a builder reads are populated.
 */
function createFakeGateway(): FakeGateway {
  const calls: Call[] = [];
  const rec = (seam: string, ...args: unknown[]): void => {
    calls.push({ seam, args });
  };

  const sessionRow = {
    sessionId: BOUND_SESSION,
    sessionTitle: 'Bound session',
    provider: 'claude',
    projectId: null,
    lastActivity: null,
  };

  const visibleContext = {
    listUiClients: () => {
      rec('visibleContext.listUiClients');
      return [];
    },
    requestUiState: async () => {
      rec('visibleContext.requestUiState');
      return [];
    },
    listNavigations: () => {
      rec('visibleContext.listNavigations');
      return [];
    },
  } as unknown as McpUiVisibleContextDeps;

  const readTools = {
    now: () => NOW,
    projects: {
      getProjectsWithSessions: async () => [],
      getArchivedProjectsWithSessions: async () => [],
      getProjectSessionsPage: async () => ({ sessions: [] }),
    },
    sessions: {
      listRecentSessions: () => {
        rec('readTools.sessions.listRecentSessions');
        return { conversations: [sessionRow] };
      },
      readSessionLifecycle: () => {
        rec('readTools.sessions.readSessionLifecycle');
        return null;
      },
      fetchHistory: async () => ({ messages: [] }),
      fetchOutline: async () => ({}),
      fetchWindowAround: async () => ({}),
    },
    hosts: {
      snapshot: () => [],
      liveHostForSession: (sessionId: string) => {
        rec('readTools.hosts.liveHostForSession', sessionId);
        return null;
      },
    },
    runs: {
      listRunningRuns: () => {
        rec('readTools.runs.listRunningRuns');
        return [];
      },
    },
  } as unknown as McpReadToolDeps;

  const runGet = {
    runs: {
      getRunById: (runId: string) => {
        rec('runGet.runs.getRunById', runId);
        // A live run, so `run_get` answers a reading (a HIT) rather than the
        // AC-287 `RUN_NOT_FOUND` refusal — the route's returned value is what
        // this comparison reads.
        return { runId, sessionId: BOUND_SESSION, source: 'mcp', status: 'running', startedAt: NOW, completedAt: null };
      },
      getRunBootId: () => {
        rec('runGet.runs.getRunBootId');
        return null;
      },
    },
    activity: { snapshot: () => null },
    sessions: { fetchHistory: async () => ({ messages: [] }) },
    now: () => NOW,
    sleep: async () => undefined,
    bootId: () => 'boot-1',
  } as unknown as McpRunGetDeps;

  const approvals = {
    control: {
      pendingApprovals: async (caller: unknown, input: unknown) => {
        rec('approvals.control.pendingApprovals', caller, input);
        return { ok: true, approvals: [] };
      },
      answerApproval: async () => {
        throw new Error('answerApproval is not part of this criterion');
      },
    },
    now: () => NOW,
  } as unknown as McpApprovalsDeps;

  const sessionBackground = {
    sessions: {
      getSessionById: (sessionId: string) => {
        rec('sessionBackground.sessions.getSessionById', sessionId);
        return { provider: 'claude' };
      },
    },
    hosts: {
      liveHostForSession: (sessionId: string) => {
        rec('sessionBackground.hosts.liveHostForSession', sessionId);
        return null;
      },
    },
    control: {
      stopTask: async () => {
        throw new Error('stopTask is not part of this criterion');
      },
    },
  } as unknown as McpSessionBackgroundDeps;

  const sessionSend = {
    control: {
      send: async (caller: unknown, input: unknown) => {
        rec('sessionSend.control.send', caller, input);
        return { ok: true, runId: 'run-1', queued: false, queuedMessageUuid: null };
      },
    },
    runs: {
      getRun: (sessionId: string) => {
        rec('sessionSend.runs.getRun', sessionId);
        return { runId: 'run-1', source: 'mcp', status: 'running' };
      },
    },
    runGet: {
      deps: {},
      build: async () => ({}),
    },
  } as unknown as McpSessionSendDeps;

  return { calls, visibleContext, readTools, runGet, approvals, sessionBackground, sessionSend };
}

/** The gateway principal the executor's first-party caller adapts onto. */
const EXPECTED_PRINCIPAL: McpPrincipal = {
  userId: USER_ID,
  tokenId: 0,
  clientId: null,
  scopes: [SCOPE],
};
const CTX = { principal: EXPECTED_PRINCIPAL };

/** Reads one handler off the routing table, failing loudly if the route is missing. */
function route(executor: RealtimeToolExecutor, name: string) {
  const handler = executor[name];
  if (handler === undefined) throw new Error(`the executor routes no "${name}" handler`);
  return handler;
}

// ── AC1: the six routes delegate to the gateway's own build functions ────────────────────────

test('AC1: every one of the six routes lands on the gateway`s own build function, arguments unchanged', async () => {
  const executorGateway = createFakeGateway();
  const refusals: VoiceRealtimeSessionRefusal[] = [];
  const executor = createVoiceRealtimeLiveExecutor({
    boundSessionId: BOUND_SESSION,
    caller: { userId: USER_ID, scopes: [SCOPE] },
    visibleContext: executorGateway.visibleContext,
    readTools: executorGateway.readTools,
    runGet: executorGateway.runGet,
    approvals: executorGateway.approvals,
    sessionBackground: executorGateway.sessionBackground,
    sessionSend: executorGateway.sessionSend,
    onSessionRefusal: (refusal) => refusals.push(refusal),
  });

  // The routing table is exactly the six tools — no route silently missing.
  assert.deepEqual(Object.keys(executor).sort(), [
    'approvals_list',
    'run_get',
    'session_background',
    'session_get',
    'session_send',
    'ui_visible_context',
  ]);

  const uiInput: McpUiVisibleContextInput = {};
  const runInput: McpRunGetInput = { runId: 'run-1', waitSeconds: 0 };
  const approvalsInput: McpApprovalsListInput = {};
  const backgroundInput: McpSessionBackgroundInput = { session: BOUND_SESSION };
  const sendArgs = { session: BOUND_SESSION, message: 'hello from voice' };

  // Each entry: the executor route, its args, and the direct build call to compare against.
  const cases: ReadonlyArray<{
    name: string;
    args: Record<string, unknown>;
    build: (gateway: FakeGateway) => unknown;
  }> = [
    {
      name: 'ui_visible_context',
      args: uiInput as Record<string, unknown>,
      build: (g) => buildUiVisibleContext(g.visibleContext, uiInput),
    },
    {
      name: 'session_get',
      args: { session: BOUND_SESSION },
      build: (g) => buildSessionDetail(g.readTools, BOUND_SESSION),
    },
    {
      name: 'run_get',
      args: runInput as Record<string, unknown>,
      build: (g) => buildRunGet(runInput, g.runGet),
    },
    {
      name: 'approvals_list',
      args: approvalsInput as Record<string, unknown>,
      build: (g) => buildApprovalsList(approvalsInput, CTX, g.approvals),
    },
    {
      name: 'session_background',
      args: backgroundInput as Record<string, unknown>,
      build: (g) => buildSessionBackground(backgroundInput, CTX, g.sessionBackground),
    },
    {
      name: 'session_send',
      args: sendArgs,
      build: (g) => buildSessionSend({ session: BOUND_SESSION, message: sendArgs.message }, CTX, g.sessionSend),
    },
  ];

  for (const testCase of cases) {
    const directGateway = createFakeGateway();
    const viaExecutor = await route(executor, testCase.name)(testCase.args);
    const viaBuild = await testCase.build(directGateway);

    // Same value...
    assert.deepEqual(viaExecutor, viaBuild, `${testCase.name}: the route must return what the build function returns`);
    // ...reached through the same service interactions (so the route is not a
    // second copy that happens to return an equal shape).
    assert.deepEqual(
      executorGateway.calls,
      directGateway.calls,
      `${testCase.name}: the route must touch the same services in the same order as the build function`,
    );
    // The route is not answering without reaching any service at all.
    assert.ok(
      directGateway.calls.length > 0,
      `${testCase.name}: the build function must have touched at least one injected service`,
    );

    // Reset the executor's log for the next case (the direct gateway is fresh each time).
    executorGateway.calls.length = 0;
  }

  // A well-formed send is never a refusal.
  assert.deepEqual(refusals, []);
});

// ── AC2: session_send reaches the control seam as a `mcp` caller ──────────────────────────────

test('AC2: session_send calls the control seam with a `mcp` caller and reports the `mcp` source', async () => {
  const gateway = createFakeGateway();
  const executor = createVoiceRealtimeLiveExecutor({
    boundSessionId: BOUND_SESSION,
    caller: { userId: USER_ID, scopes: [SCOPE] },
    visibleContext: gateway.visibleContext,
    readTools: gateway.readTools,
    runGet: gateway.runGet,
    approvals: gateway.approvals,
    sessionBackground: gateway.sessionBackground,
    sessionSend: gateway.sessionSend,
    onSessionRefusal: () => {},
  });

  const result = (await route(executor, 'session_send')({
    session: BOUND_SESSION,
    message: 'open the failing test',
  })) as { runId: string; source: string };

  // The control seam was reached exactly once, with a caller whose `via` is `mcp`
  // and whose `userId` is the first-party user — that is what makes the run the
  // control service opens record its origin as `mcp`.
  const sendCall = gateway.calls.find((call) => call.seam === 'sessionSend.control.send');
  assert.ok(sendCall, 'session_send must reach the control seam');
  assert.deepEqual(sendCall.args[0], { userId: USER_ID, via: 'mcp' });
  assert.deepEqual(sendCall.args[1], { sessionId: BOUND_SESSION, content: 'open the failing test' });

  // The payload the model sees reports the `mcp` source the run carries.
  assert.equal(result.runId, 'run-1');
  assert.equal(result.source, 'mcp');
});

// ── AC3: the parameter whitelist refuses and records a foreign session ────────────────────────

test('AC3: a send naming another session is refused, recorded, and never reaches that session', async () => {
  const gateway = createFakeGateway();
  const refusals: VoiceRealtimeSessionRefusal[] = [];
  const executor = createVoiceRealtimeLiveExecutor({
    boundSessionId: BOUND_SESSION,
    caller: { userId: USER_ID, scopes: [SCOPE] },
    visibleContext: gateway.visibleContext,
    readTools: gateway.readTools,
    runGet: gateway.runGet,
    approvals: gateway.approvals,
    sessionBackground: gateway.sessionBackground,
    sessionSend: gateway.sessionSend,
    onSessionRefusal: (refusal) => refusals.push(refusal),
  });

  const FOREIGN_SESSION = 'sess-someone-else';

  await assert.rejects(
    async () => {
      await route(executor, 'session_send')({ session: FOREIGN_SESSION, message: 'nope' });
    },
    (error: unknown) => {
      assert.ok(error instanceof VoiceRealtimeSessionRefusalError, 'the refusal must be the executor`s own error');
      assert.equal(error.refusal.requestedSession, FOREIGN_SESSION);
      return true;
    },
  );

  // Recorded, with the raw attempt intact for later troubleshooting.
  assert.equal(refusals.length, 1, 'the refusal must be recorded exactly once');
  assert.equal(refusals[0].boundSessionId, BOUND_SESSION);
  assert.equal(refusals[0].requestedSession, FOREIGN_SESSION);
  assert.deepEqual(refusals[0].rawArguments, { session: FOREIGN_SESSION, message: 'nope' });

  // The foreign session was never acted on: no send reached the control seam at all.
  assert.equal(
    gateway.calls.some((call) => call.seam === 'sessionSend.control.send'),
    false,
    'a refused call must not reach the control seam',
  );

  // A call that names NO session is sent to the BOUND session — being bound is
  // what makes an omitted target safe rather than ambiguous.
  const payload = (await route(executor, 'session_send')({ message: 'just the message' })) as {
    runId: string;
  };
  assert.equal(payload.runId, 'run-1');
  const sendCall = gateway.calls.find((call) => call.seam === 'sessionSend.control.send');
  assert.ok(sendCall, 'the bound-session send must reach the control seam');
  assert.equal((sendCall.args[1] as { sessionId: string }).sessionId, BOUND_SESSION);
  assert.equal(refusals.length, 1, 'a bound-session send is not a refusal');
});

// ── AC-307 guard: the ambiguity criterion runner resolves `@/` against server/tsconfig ────────
//
// The AC-307 criterion is the literal command `node experiments/voice-realtime-ambiguity/run.mjs`.
// After AC-310 put a `@/*`-importing module (this very live executor) into the voice-realtime
// barrel the runner imports, the runner's tsx registration must name `server/tsconfig.json`: a bare
// `register()` reads the REPO-ROOT tsconfig (`@/*` → `src/*`), so the server-side alias does not
// resolve and the runner dies with `Cannot find package '@/modules'` before printing a single
// reading. This guard spawns that bare command with the ambient tsx env WASHED — the repo is
// documented to export `TSX_TSCONFIG_PATH`, and leaving it in place would substitute the tsconfig
// the runner is supposed to name itself, keeping this test green through the very gap it guards.
test('AC-307 guard: `node experiments/voice-realtime-ambiguity/run.mjs` resolves `@/` from server/tsconfig under a washed tsx env', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const runner = fileURLToPath(
    new URL('../../../../experiments/voice-realtime-ambiguity/run.mjs', import.meta.url),
  );

  // Wash every ambient variable that could hand the runner a tsconfig in place of its own register.
  const env = { ...process.env };
  delete env.TSX_TSCONFIG_PATH;
  delete env.TSX_TS_CONFIG_PATH;

  const result = spawnSync(process.execPath, [runner], { cwd: repoRoot, env, encoding: 'utf8' });

  assert.equal(
    result.status,
    0,
    'the AC-307 criterion runner must exit 0 under a washed env — a bare `register()` reads the ' +
      `repo-root tsconfig and dies with \`Cannot find package '@/modules'\`\n--- stderr ---\n${result.stderr}`,
  );
});
