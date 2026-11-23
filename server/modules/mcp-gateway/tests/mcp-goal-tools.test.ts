/**
 * Criterion for the MCP gateway's goal tools (`mcp-goal-tools.ts`).
 *
 * Readings, one leg each:
 *   (a) `registerMcpGoalTools` installs exactly `MCP_GOAL_TOOLS`, with the scope
 *       each row declares (read / create / control) and a schema + handler;
 *   (b) a real `/mcp` `tools/list` carries the nine names WITH annotations from
 *       the one `MCP_TOOL_ANNOTATIONS` table;
 *   (c) every mutating handler calls the injected service with the PRINCIPAL's
 *       user id — never a caller-supplied one — and forwards the documented
 *       arguments (create / add_ac / activate / pause / resume / abandon /
 *       run_round);
 *   (d) a goal owned by somebody else answers the SAME envelope as a goal that
 *       does not exist (`INVALID_ARGUMENT` with `details.reason
 *       'GOAL_NOT_FOUND'`), and `goal_run_round` refuses before the owner-agnostic
 *       round runner is reached;
 *   (e) service refusals are translated onto the gateway vocabulary (a state
 *       conflict is `INVALID_ARGUMENT` with the service code in
 *       `details.reason`; an unknown project stays `PROJECT_NOT_FOUND`);
 *   (f) a mount without `goalTools` registers no goal tool at all.
 *
 * The mount is real (express + the SDK client over a `node:http`-based fetch, the
 * sibling criteria's seam): a listing client reads `tools/list`, and the error
 * leg reads the envelope back off the wire so the "same shape" reading is about
 * what a caller receives, not about a local object.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { Goal, GoalAc, GoalBudget, GoalEvidence, GoalRound } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { McpGoalToolDeps, McpGoalToolRegistration, McpPrincipal } from '../index.js';

// `shared/utils.ts` freezes IS_PLATFORM on first import and the auth middleware
// reads the JWT secret at module load, so the environment is set BEFORE any
// aliased module is pulled in — every application module below is dynamic.
process.env.JWT_SECRET = 'mcp-goal-tools-test-secret';
delete process.env.VITE_IS_PLATFORM;

// Every call below reaches the audited wrapper, which writes one
// `mcp_audit_log` row, so the file needs a migrated temp database.
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-goal-tools-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');
const { closeConnection, initializeDatabase } = await import('@/modules/database/index.js');
await initializeDatabase();
after(() => {
  closeConnection();
  rmSync(dbDirectory, { recursive: true, force: true });
});

const { MCP_GATEWAY_PATH, MCP_GOAL_TOOLS, MCP_TOOL_ANNOTATIONS, mountMcpGateway, registerMcpGoalTools } =
  await import('../index.js');

// --------------------------- fixtures ---------------------------

const OWNER = 7;
const OTHER_OWNER = 8;
const OWNED_GOAL_ID = 'goal-owned';
const OTHER_GOAL_ID = 'goal-of-somebody-else';
const MISSING_GOAL_ID = 'goal-missing';
const PROJECT_ID = 'proj-1';

const PRINCIPAL: McpPrincipal = { userId: OWNER, tokenId: 1, clientId: null, scopes: ['cloudcli:read'] };

const BUDGET: GoalBudget = { maxRounds: 20, maxWallClockMs: 7_200_000, maxNoProgress: 3 };

function makeGoal(id: string, status: Goal['status'], userId = OWNER): Goal {
  return {
    id,
    userId,
    projectId: PROJECT_ID,
    sessionId: null,
    worktreePath: null,
    branch: null,
    title: `Goal ${id}`,
    objective: 'Prove the goal tools work.',
    exitConditions: [],
    status,
    budget: BUDGET,
    createdAt: '2026-11-12T00:00:00.000Z',
    activatedAt: null,
    achievedAt: null,
  };
}

const AC: GoalAc = {
  id: `${OWNED_GOAL_ID}-AC-001`,
  goalId: OWNED_GOAL_ID,
  title: 'The criterion runs',
  criterion: 'node --test',
  expect: 'the suite fails before the fix',
  status: 'active',
  createdAt: '2026-11-12T00:00:00.000Z',
};

const ROUND: GoalRound = {
  id: 'round-1',
  goalId: OWNED_GOAL_ID,
  seq: 1,
  startedAt: '2026-11-12T00:01:00.000Z',
  endedAt: '2026-11-12T00:02:00.000Z',
  outcome: 'progress',
  diffDigest: 'diff-digest',
  promptDigest: 'prompt-digest',
};

const EVIDENCE: GoalEvidence = {
  id: 'evidence-1',
  roundId: ROUND.id,
  acId: AC.id,
  exitCode: 1,
  timedOut: false,
  outputDigest: 'output-digest',
  outputExcerpt: 'not ok',
  verdict: 'fail',
  at: '2026-11-12T00:02:00.000Z',
};

/** One recorded service call, so an assertion can read the verb AND its arguments. */
type RecordedCall = { verb: string; args: unknown[] };

/**
 * A fake goals service that records every call.
 *
 * `getGoal` follows the REAL ownership rule: a goal owned by another user
 * answers `null`, exactly like a goal that does not exist. `addAc` refuses a
 * non-draft goal with the service's own `AppError`, so the adapter's translation
 * is exercised rather than assumed.
 */
function createFakeDeps(): {
  deps: McpGoalToolDeps;
  calls: RecordedCall[];
  runRoundCalls: string[];
} {
  const calls: RecordedCall[] = [];
  const runRoundCalls: string[] = [];
  const owned = makeGoal(OWNED_GOAL_ID, 'draft');

  const service: McpGoalToolDeps['service'] = {
    createGoal(input) {
      calls.push({ verb: 'createGoal', args: [input] });
      return { ...owned, id: 'goal-created', title: input.title, objective: input.objective };
    },
    listGoals(projectId, userId) {
      calls.push({ verb: 'listGoals', args: [projectId, userId] });
      return [owned];
    },
    getGoal(goalId, userId) {
      calls.push({ verb: 'getGoal', args: [goalId, userId] });
      if (goalId === OWNED_GOAL_ID && userId === OWNER) {
        return { goal: owned, acs: [AC], rounds: [ROUND], evidence: [EVIDENCE] };
      }
      // `OTHER_GOAL_ID` belongs to `OTHER_OWNER`; `MISSING_GOAL_ID` exists
      // nowhere. Both leave here as `null` — the service's real reading.
      return null;
    },
    addAc(goalId, userId, input) {
      calls.push({ verb: 'addAc', args: [goalId, userId, input] });
      if (goalId === 'goal-active') {
        throw new AppError('Acceptance criteria can only be added while the goal is a draft.', {
          code: 'GOAL_ACS_CLOSED',
          statusCode: 409,
        });
      }
      return { ...AC, id: `${goalId}-AC-002`, ...input };
    },
    async activate(goalId, userId, input) {
      calls.push({ verb: 'activate', args: [goalId, userId, input] });
      if (goalId === 'goal-unknown-project') {
        throw new AppError('Project "gone" does not exist.', {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      }
      return { goal: { ...owned, status: 'active' } };
    },
    pause(goalId, userId) {
      calls.push({ verb: 'pause', args: [goalId, userId] });
      return { ...owned, status: 'paused' };
    },
    resume(goalId, userId) {
      calls.push({ verb: 'resume', args: [goalId, userId] });
      return { ...owned, status: 'active' };
    },
    abandon(goalId, userId) {
      calls.push({ verb: 'abandon', args: [goalId, userId] });
      return { ...owned, status: 'abandoned' };
    },
  };

  return {
    deps: {
      service,
      runRound: async (goalId: string) => {
        runRoundCalls.push(goalId);
        return {
          round: ROUND,
          readings: [
            {
              acId: AC.id,
              reading: {
                exitCode: 1,
                timedOut: false,
                output: 'not ok',
                outputDigest: 'output-digest',
                verdict: 'fail',
              },
            },
          ],
          allGreen: false,
          redAcs: [AC],
          prompt: 'Make the criterion pass.',
          merge: null,
          stalled: false,
        };
      },
    },
    calls,
    runRoundCalls,
  };
}

/**
 * The registration seam of this module: it records what `registerMcpGoalTools`
 * installs, so the declared scope (which `tools/list` does not expose) is read
 * back from the registration itself.
 */
function recordRegistrations(deps: McpGoalToolDeps): McpGoalToolRegistration[] {
  const registered: McpGoalToolRegistration[] = [];
  registerMcpGoalTools((registration) => registered.push(registration), deps);
  return registered;
}

/** Invokes one registered handler with the test principal, without the audited wrapper. */
async function callHandler(
  registered: McpGoalToolRegistration[],
  name: string,
  args: Record<string, unknown>,
  userId = OWNER,
): Promise<unknown> {
  const tool = registered.find((registration) => registration.name === name);
  assert.ok(tool !== undefined, `${name} must be registered`);
  return tool.handler(args, { principal: { ...PRINCIPAL, userId } });
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

/** One mounted gateway and its connected client. */
type Mount = { client: Client; close: () => Promise<void> };

/**
 * Mounts `/mcp` with the given goal deps bag (or without one) and connects a
 * client that lists every tool — the same real mount the sibling criteria use.
 */
async function startGateway(goalTools: McpGoalToolDeps | undefined): Promise<Mount> {
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = PRINCIPAL;
    next();
  };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize,
    ...(goalTools === undefined ? {} : { goalTools }),
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`),
    { fetch: nodeFetch },
  );
  const client = new Client({ name: 'goal-tools-criterion', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let withGoals: Mount;
let withoutGoals: Mount;

before(async () => {
  withGoals = await startGateway(createFakeDeps().deps);
  withoutGoals = await startGateway(undefined);
});

after(async () => {
  await withGoals.close();
  await withoutGoals.close();
});

// --------------------------- (a) the table and the registrations ---------------------------

test('(a) registerMcpGoalTools installs exactly MCP_GOAL_TOOLS with their declared scopes', () => {
  const registered = recordRegistrations(createFakeDeps().deps);

  assert.deepEqual(
    registered.map((registration) => registration.name),
    MCP_GOAL_TOOLS.map((tool) => tool.name),
    'the registrations must be exactly the table, in order',
  );

  const scopeByName = new Map<string, string>(
    MCP_GOAL_TOOLS.map((tool) => [tool.name, tool.requiredScope] as const),
  );
  assert.equal(scopeByName.get('goal_list'), 'cloudcli:read');
  assert.equal(scopeByName.get('goal_status'), 'cloudcli:read');
  assert.equal(scopeByName.get('goal_create'), 'cloudcli:session:create');
  for (const name of ['goal_add_ac', 'goal_activate', 'goal_pause', 'goal_resume', 'goal_abandon', 'goal_run_round']) {
    assert.equal(scopeByName.get(name), 'cloudcli:session:control', `${name} must require the control scope`);
  }

  for (const registration of registered) {
    assert.ok(registration.description.length > 0, `${registration.name} must carry a description`);
    assert.ok(registration.inputSchema !== undefined, `${registration.name} must declare an input schema`);
    assert.ok(registration.outputSchema !== undefined, `${registration.name} must declare an output schema`);
    assert.equal(typeof registration.handler, 'function', `${registration.name} must install a handler`);
  }
});

// --------------------------- (b) tools/list ---------------------------

test('(b) a real tools/list carries the nine goal tools with their annotations', async () => {
  const listed = await withGoals.client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

  for (const tool of MCP_GOAL_TOOLS) {
    const advertised = byName.get(tool.name);
    assert.ok(advertised !== undefined, `${tool.name} must appear on tools/list`);
    assert.deepEqual(
      advertised.annotations,
      MCP_TOOL_ANNOTATIONS[tool.name],
      `${tool.name} must carry its one-table annotations verbatim`,
    );
  }
  assert.equal(byName.get('goal_list')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('goal_status')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('goal_create')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('goal_abandon')?.annotations?.destructiveHint, true);
});

// --------------------------- (c) principal identity and arguments ---------------------------

test('(c) every handler calls the service as the PRINCIPAL user, never a caller-supplied id', async () => {
  const fake = createFakeDeps();
  const registered = recordRegistrations(fake.deps);

  await callHandler(registered, 'goal_list', { project: PROJECT_ID });
  assert.deepEqual(fake.calls.at(-1), { verb: 'listGoals', args: [PROJECT_ID, OWNER] });

  await callHandler(registered, 'goal_create', {
    project: PROJECT_ID,
    projectPath: '/tmp/project',
    title: 'New goal',
    objective: 'Ship it',
    exitConditions: ['x-AC-001'],
    budget: { maxRounds: 3 },
    // A hostile caller cannot redirect ownership: the handler never reads this.
    userId: OTHER_OWNER,
  });
  const createCall = fake.calls.at(-1);
  assert.ok(createCall !== undefined && createCall.verb === 'createGoal');
  const createInput = createCall.args[0] as Record<string, unknown>;
  assert.equal(createInput.userId, OWNER, 'goal_create must stamp the principal user id');
  assert.equal(createInput.projectId, PROJECT_ID);
  assert.equal(createInput.projectPath, '/tmp/project');
  assert.equal(createInput.title, 'New goal');
  assert.deepEqual(createInput.exitConditions, ['x-AC-001']);
  assert.deepEqual(createInput.budget, { maxRounds: 3 });

  await callHandler(registered, 'goal_add_ac', {
    goalId: OWNED_GOAL_ID,
    title: 'AC',
    criterion: 'node --test',
    expect: 'it fails first',
  });
  assert.deepEqual(fake.calls.at(-1), {
    verb: 'addAc',
    args: [
      OWNED_GOAL_ID,
      OWNER,
      { title: 'AC', criterion: 'node --test', expect: 'it fails first' },
    ],
  });

  await callHandler(registered, 'goal_activate', { goalId: OWNED_GOAL_ID });
  assert.deepEqual(fake.calls.at(-1), {
    verb: 'activate',
    args: [OWNED_GOAL_ID, OWNER, { provider: 'claude' }],
  }, 'goal_activate must default the provider to claude');
  await callHandler(registered, 'goal_activate', { goalId: OWNED_GOAL_ID, provider: 'codex' });
  assert.deepEqual(fake.calls.at(-1), {
    verb: 'activate',
    args: [OWNED_GOAL_ID, OWNER, { provider: 'codex' }],
  });

  for (const verb of ['pause', 'resume', 'abandon'] as const) {
    await callHandler(registered, `goal_${verb}`, { goalId: OWNED_GOAL_ID });
    assert.deepEqual(fake.calls.at(-1), { verb, args: [OWNED_GOAL_ID, OWNER] });
  }

  const round = (await callHandler(registered, 'goal_run_round', { goalId: OWNED_GOAL_ID })) as {
    goalId: string;
    redAcIds: string[];
    merge: unknown;
  };
  assert.deepEqual(fake.runRoundCalls, [OWNED_GOAL_ID], 'goal_run_round must run one round of that goal');
  assert.equal(round.goalId, OWNED_GOAL_ID);
  assert.deepEqual(round.redAcIds, [AC.id], 'the payload must name the ACs still red');
  assert.equal(round.merge, null);
});

// --------------------------- (d) another user's goal ---------------------------

test('(d) another user\'s goal answers the same envelope as a missing goal', async () => {
  const fake = createFakeDeps();
  const registered = recordRegistrations(fake.deps);

  const other = await callHandler(registered, 'goal_status', { goalId: OTHER_GOAL_ID }).catch(
    (error: unknown) => error,
  );
  const missing = await callHandler(registered, 'goal_status', { goalId: MISSING_GOAL_ID }).catch(
    (error: unknown) => error,
  );

  for (const [label, outcome] of [['other owner', other], ['missing', missing]] as const) {
    const envelope = outcome as { code?: string; details?: { reason?: string; goalId?: string } };
    assert.equal(envelope.code, 'INVALID_ARGUMENT', `${label}: the refusal must use the gateway vocabulary`);
    assert.equal(envelope.details?.reason, 'GOAL_NOT_FOUND', `${label}: the service's code must be carried`);
  }
  assert.equal((other as { code?: string }).code, (missing as { code?: string }).code);
  assert.equal(
    (other as { details?: { reason?: string } }).details?.reason,
    (missing as { details?: { reason?: string } }).details?.reason,
    'a goal owned by another user must be indistinguishable from a missing one',
  );
  assert.equal(
    (other as { details?: { goalId?: string } }).details?.goalId,
    OTHER_GOAL_ID,
    'the envelope names the id the caller asked for, not the owner',
  );

  // The same refusal travels the real mount as a 404-shaped error envelope.
  const reading = (await withGoals.client.callTool({
    name: 'goal_status',
    arguments: { goalId: MISSING_GOAL_ID },
  })) as { isError?: boolean; structuredContent?: { code?: string; details?: { reason?: string } } };
  assert.equal(reading.isError, true);
  assert.equal(reading.structuredContent?.code, 'INVALID_ARGUMENT');
  assert.equal(reading.structuredContent?.details?.reason, 'GOAL_NOT_FOUND');
});

test('(d) goal_run_round refuses another user\'s goal before the round runner is reached', async () => {
  const fake = createFakeDeps();
  const registered = recordRegistrations(fake.deps);

  await assert.rejects(callHandler(registered, 'goal_run_round', { goalId: OTHER_GOAL_ID }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENT');
    return true;
  });
  assert.deepEqual(fake.runRoundCalls, [], 'no criterion may run for a goal the caller does not own');
});

// --------------------------- (e) service refusals ---------------------------

test('(e) a service state conflict is INVALID_ARGUMENT carrying the service code', async () => {
  const fake = createFakeDeps();
  const registered = recordRegistrations(fake.deps);

  await assert.rejects(
    callHandler(registered, 'goal_add_ac', {
      goalId: 'goal-active',
      title: 'AC',
      criterion: 'node --test',
      expect: 'it fails first',
    }),
    (error: unknown) => {
      const typed = error as { code?: string; details?: { reason?: string; goalId?: string } };
      assert.equal(typed.code, 'INVALID_ARGUMENT');
      assert.equal(typed.details?.reason, 'GOAL_ACS_CLOSED');
      assert.equal(typed.details?.goalId, 'goal-active');
      return true;
    },
  );
});

test('(e) an unknown project keeps the gateway\'s PROJECT_NOT_FOUND', async () => {
  const fake = createFakeDeps();
  const registered = recordRegistrations(fake.deps);

  await assert.rejects(callHandler(registered, 'goal_activate', { goalId: 'goal-unknown-project' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'PROJECT_NOT_FOUND');
    return true;
  });
});

// --------------------------- (f) mounts without the bag ---------------------------

test('(f) a mount without goalTools registers no goal tool', async () => {
  const listed = await withoutGoals.client.listTools();
  const goalNames = listed.tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('goal_'));

  assert.deepEqual(goalNames, [], 'an unwired mount must not advertise any goal tool');
  assert.deepEqual(listed.tools, [], 'the goal-less mount stays the empty tools-less mount');
});
