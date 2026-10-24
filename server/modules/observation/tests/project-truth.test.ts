/**
 * The project-truth producer's criteria (AC1, AC2).
 *
 * AC1 — the five-layer reading, over a snapshot fixture:
 *   · every layer is present and the five states are computed from their own source;
 *   · every green layer carries an activity instant;
 *   · a project with no deployment concept reads deploy as `not-applicable`, is NOT counted as
 *     green, and a failing deploy reader cannot turn that project red;
 *   · a driver whose last tick is past the threshold reads red, and the delta names the silence;
 *   · a `not-evaluated` AC gate makes the verification layer `unevaluated`, never green.
 *
 * AC2 — the write path:
 *   · only tasks that became done AFTER the previous observation's cursor appear as 「落地」;
 *   · an unavailable fleet read port makes the liveness layer `unevaluated` with its reason;
 *   · the same project read from a stubbed `liveness --json` document and a stubbed
 *     `status --json` document produces the same five-layer reading.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/project-truth.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  createQuayFleetLivenessReader,
  type QuayFleetLivenessReading,
} from '@/modules/quay/index.js';

import { formatProjectUri } from '../observation-uri.js';
import {
  createObservationStore,
  type ObservationStore,
  type ObservedObject,
} from '../observation-store.js';
import {
  buildProjectTruth,
  type ProjectTruthBoardReading,
  type ProjectTruthDeployReading,
  type ProjectTruthLayers,
  type ProjectTruthProjectRef,
  type ProjectTruthTaskRow,
} from '../project-truth.js';
import { createProjectTruthProducer } from '../project-truth.producer.js';

/** A fixed instant; every fixture time is expressed relative to it. */
const NOW = 1_700_000_000_000;
const CLOUD_PROJECT_ID = 'cloudcli-uuid';
const FLEET_PROJECT_ID = 'claudecodeui';

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;

let clock = NOW;
const store: ObservationStore = createObservationStore({ now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-project-truth-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
});

test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test.beforeEach(() => {
  const db = getConnection();
  db.exec('DELETE FROM observed_revisions');
  db.exec('DELETE FROM observed_objects');
  db.exec('DELETE FROM observation_seen_cursors');
});

function makeProject(overrides: Partial<ProjectTruthProjectRef> = {}): ProjectTruthProjectRef {
  return {
    projectId: CLOUD_PROJECT_ID,
    projectPath: '/data/home/yale/work/claudecodeui',
    title: 'CloudCLI',
    fleetProjectId: FLEET_PROJECT_ID,
    deploy: { healthUrl: 'http://127.0.0.1:3001', ref: 'HEAD' },
    ...overrides,
  };
}

function task(overrides: Partial<ProjectTruthTaskRow> & { taskId: string }): ProjectTruthTaskRow {
  return { title: overrides.taskId, status: 'done', updatedAt: NOW - 10_000, ...overrides };
}

/** The default board: one in-flight task, two done tasks (one inside / one before the window). */
function makeBoard(overrides: Partial<ProjectTruthBoardReading> = {}): ProjectTruthBoardReading {
  return {
    tasks: [
      task({ taskId: 'T-flight', title: 'in flight', status: 'ready', updatedAt: NOW - 60_000 }),
      task({ taskId: 'T-recent', title: 'landed recently', updatedAt: NOW - 30_000 }),
      task({ taskId: 'T-old', title: 'landed earlier', updatedAt: NOW - 120_000 }),
    ],
    inFlight: [
      {
        taskId: 'T-flight',
        title: 'in flight',
        phase: 'running',
        startedAt: NOW - 50_000,
        lastHeartbeat: NOW - 5_000,
      },
    ],
    goals: [
      {
        criterionId: 'AC-101',
        goal: 'GOAL-101',
        title: 'the criterion holds',
        status: 'achieved',
        kind: 'criterion',
        gate: 'pass',
        gateAt: NOW - 20_000,
      },
    ],
    inFlightUnavailableReason: null,
    tasksUnavailableReason: null,
    goalsUnavailableReason: null,
    ...overrides,
  };
}

const FRESH_DEPLOY: ProjectTruthDeployReading = {
  kind: 'fresh',
  buildSha: 'abc123',
  headSha: 'abc123',
  checkedAt: NOW - 1_000,
};

function makeLiveness(
  overrides: Partial<QuayFleetLivenessReading['projects'][number]> = {},
): QuayFleetLivenessReading {
  return {
    available: true,
    source: 'liveness',
    at: new Date(NOW).toISOString(),
    fleet: { state: 'ok', lastTickAt: new Date(NOW).toISOString(), ageSec: 5 },
    projects: [
      {
        projectId: FLEET_PROJECT_ID,
        driverState: 'ok',
        driverAgeSec: 5,
        driverReason: null,
        lastGateAt: null,
        halted: false,
        ...overrides,
      },
    ],
    reason: null,
  };
}

type StoredDigest = {
  observedAt: number;
  layers: ProjectTruthLayers;
  needsHuman: number;
};

/** The store's digest is opaque JSON; the criterion reads it back through this one cast. */
function storedDigest(object: ObservedObject | null): StoredDigest {
  assert.ok(object !== null, 'the producer must write a revision');
  return object.digest as unknown as StoredDigest;
}

function build(overrides: {
  project?: ProjectTruthProjectRef;
  board?: ProjectTruthBoardReading;
  deploy?: ProjectTruthDeployReading;
  liveness?: QuayFleetLivenessReading;
  cursor?: number | null;
} = {}) {
  return buildProjectTruth({
    project: overrides.project ?? makeProject(),
    board: overrides.board ?? makeBoard(),
    deploy: overrides.deploy ?? FRESH_DEPLOY,
    liveness: overrides.liveness ?? makeLiveness(),
    cursor: overrides.cursor ?? NOW - 60_000,
    previous: null,
    now: NOW,
  });
}

// ---------------------------------------------------------------------------
// AC1 — the five-layer reading
// ---------------------------------------------------------------------------

test('AC1: a snapshot fixture yields all five layers, each from its own source', () => {
  const reading = build();
  const layers = reading.digest.layers;

  assert.deepEqual(Object.keys(layers).sort(), [
    'deploy',
    'inflight',
    'landed',
    'liveness',
    'verification',
  ]);

  assert.equal(layers.inflight.state, 'ok');
  assert.deepEqual(layers.inflight.tasks.map((entry) => entry.taskId), ['T-flight']);
  assert.equal(layers.inflight.tasks[0]?.phase, 'running');

  assert.equal(layers.landed.state, 'ok');
  assert.deepEqual(layers.landed.tasks.map((entry) => entry.taskId), ['T-recent']);
  assert.equal(layers.landed.since, NOW - 60_000);

  assert.equal(layers.deploy.state, 'ok');
  assert.equal(layers.deploy.buildSha, 'abc123');

  assert.equal(layers.verification.state, 'ok');
  assert.deepEqual(layers.verification.entries.map((entry) => entry.criterionId), ['AC-101']);

  assert.equal(layers.liveness.state, 'ok');
  assert.equal(layers.liveness.driverAgeSec, 5);

  // Every green layer carries the instant its liveness is anchored to.
  for (const key of ['inflight', 'landed', 'deploy', 'verification', 'liveness'] as const) {
    assert.equal(layers[key].state, 'ok', `${key} must be green for this fixture`);
    assert.notEqual(layers[key].observedAt, null, `${key} is green without an activity instant`);
  }

  assert.equal(reading.status.state, 'ok');
  assert.ok(reading.deltaItems.includes('落地 landed recently'));
  assert.ok(!reading.deltaItems.includes('落地 landed earlier'));
});

test('AC1: a non-CloudCLI project reads deploy as not-applicable, is not green and is not reddened by the reader', () => {
  const reading = build({
    project: makeProject({ fleetProjectId: 'plantuml-js', deploy: null }),
    // Deliberately a failing reader: a project with no deployment concept must not be turned
    // red (or green) by whatever the deploy reader happened to say.
    deploy: {
      kind: 'behind',
      buildSha: 'old',
      headSha: 'new',
      behindBy: 7,
      checkedAt: NOW - 1_000,
    },
    liveness: makeLiveness({ projectId: 'plantuml-js' }),
  });

  assert.equal(reading.digest.layers.deploy.state, 'not-applicable');
  assert.notEqual(reading.digest.layers.deploy.state, 'ok');
  assert.equal(reading.digest.layers.deploy.behindBy, null);
  assert.equal(reading.status.state, 'ok');
  assert.ok(!reading.deltaItems.some((item) => item.startsWith('部署')));
});

test('AC1: a driver silent past the threshold reads red and the delta names the silence', () => {
  const reading = build({
    // 1500s = 25 minutes of silence, past the fleet's 300s default.
    liveness: makeLiveness({ driverState: 'stale', driverAgeSec: 1_500 }),
  });

  assert.equal(reading.digest.layers.liveness.state, 'red');
  assert.equal(reading.status.state, 'red');
  assert.ok(reading.deltaItems.includes('driver 静默 25 分钟'));
});

test('AC1: a not-evaluated AC gate makes verification unevaluated, never green', () => {
  const reading = build({
    board: makeBoard({
      goals: [
        {
          criterionId: 'AC-202',
          goal: 'GOAL-202',
          title: 'not run yet',
          status: 'active',
          kind: 'criterion',
          gate: 'not-evaluated',
          gateAt: null,
        },
      ],
    }),
  });

  assert.equal(reading.digest.layers.verification.state, 'unevaluated');
  assert.notEqual(reading.digest.layers.verification.state, 'ok');
  assert.match(String(reading.digest.layers.verification.reason), /未评估/);
  assert.equal(reading.status.state, 'attention');
  assert.match(String(reading.status.reason), /验证/);
});

test('AC1: a needs-human task moves the object to attention without claiming a red layer', () => {
  const reading = build({
    board: makeBoard({
      tasks: [...makeBoard().tasks, task({ taskId: 'T-human', status: 'needs-human', updatedAt: NOW - 1_000 })],
    }),
  });

  assert.equal(reading.digest.needsHuman, 1);
  assert.equal(reading.status.state, 'attention');
  assert.match(String(reading.status.reason), /needs-human/);
});

// ---------------------------------------------------------------------------
// AC2 — the write path and the one liveness reading
// ---------------------------------------------------------------------------

test('AC2: only tasks that became done after the cursor appear as 落地', async () => {
  clock = NOW;
  let currentTasks: ProjectTruthTaskRow[] = [];
  const producer = createProjectTruthProducer({
    store,
    now: () => clock,
    readBoard: async () => makeBoard({ tasks: currentTasks, inFlight: [] }),
    readDeploy: async () => FRESH_DEPLOY,
    readFleetLiveness: async () => makeLiveness(),
  });
  const project = makeProject();
  const uri = formatProjectUri(FLEET_PROJECT_ID);

  // First reading: no cursor yet, so the whole done history is NOT claimed as a landing.
  currentTasks = [task({ taskId: 'T-ancient', title: 'ancient', updatedAt: NOW - 500_000 })];
  const first = await producer.refreshProject(project);
  assert.ok(first !== null);
  assert.equal(first.revision, 1);
  assert.equal(storedDigest(first).observedAt, NOW);
  assert.deepEqual(storedDigest(first).layers.landed.tasks, []);
  assert.ok(!store.listRevisions(uri, 0)[0]?.deltaItems.some((item) => item.startsWith('落地')));

  clock = NOW + 10_000;
  currentTasks = [
    task({ taskId: 'T-before', title: 'before the cursor', updatedAt: NOW - 1_000 }),
    task({ taskId: 'T-after', title: 'after the cursor', updatedAt: NOW + 5_000 }),
  ];
  const second = await producer.refreshProject(project);
  assert.ok(second !== null);
  assert.equal(second.revision, 2);
  assert.deepEqual(
    storedDigest(second).layers.landed.tasks.map((entry) => entry.taskId),
    ['T-after'],
  );

  const revisions = store.listRevisions(uri, 0);
  assert.equal(revisions.length, 2);
  assert.ok(revisions[1]?.deltaItems.includes('落地 after the cursor'));
  assert.ok(!revisions[1]?.deltaItems.includes('落地 before the cursor'));
});

test('AC2: a failed task-list read does not swallow the landings that happened while it failed', async () => {
  clock = NOW;
  let board = makeBoard({ tasks: [], inFlight: [] });
  const producer = createProjectTruthProducer({
    store,
    now: () => clock,
    readBoard: async () => board,
    readDeploy: async () => FRESH_DEPLOY,
    readFleetLiveness: async () => makeLiveness(),
  });
  const project = makeProject();

  await producer.refreshProject(project);

  // The next reading could not read the task list; the cursor it carries forward is NOW.
  clock = NOW + 10_000;
  board = {
    ...makeBoard(),
    tasks: [],
    inFlight: [],
    tasksUnavailableReason: 'task list: exit 1',
  };
  const failed = await producer.refreshProject(project);
  assert.equal(storedDigest(failed).layers.landed.state, 'unevaluated');
  assert.equal(storedDigest(failed).layers.landed.since, NOW);

  // The following readable reading still sees a task done inside the unreadable window.
  clock = NOW + 20_000;
  board = makeBoard({
    tasks: [task({ taskId: 'T-during-outage', title: 'during the outage', updatedAt: NOW + 5_000 })],
    inFlight: [],
  });
  const recovered = await producer.refreshProject(project);
  assert.deepEqual(
    storedDigest(recovered).layers.landed.tasks.map((entry) => entry.taskId),
    ['T-during-outage'],
  );
});

test('AC2: an unavailable fleet read port makes the liveness layer unevaluated with its reason', async () => {
  clock = NOW;
  const reason = 'quay-fleet 读口不可用：liveness: exit 127；status: exit 127';
  const producer = createProjectTruthProducer({
    store,
    now: () => clock,
    readBoard: async () => makeBoard(),
    readDeploy: async () => FRESH_DEPLOY,
    readFleetLiveness: async () => ({
      available: false,
      source: 'none',
      at: null,
      fleet: null,
      projects: [],
      reason,
    }),
  });

  const object = await producer.refreshProject(makeProject());
  assert.ok(object !== null);
  const layers = storedDigest(object).layers;
  assert.equal(layers.liveness.state, 'unevaluated');
  assert.equal(layers.liveness.reason, reason);
  assert.notEqual(object.status.state, 'ok');
  assert.match(String(object.status.reason), /quay-fleet 读口不可用/);
});

test('AC2: stubbed liveness --json and status --json documents produce the same five-layer reading', async () => {
  const at = new Date(NOW).toISOString();
  const livenessDocument = {
    at,
    fleet: { state: 'ok', alive: true, tick: 9, lastTickAt: at, ageSec: 5, source: 'heartbeat.json' },
    projects: [
      {
        projectId: FLEET_PROJECT_ID,
        state: 'ok',
        driver: { state: 'ok', lastHeartbeatAt: at, ageSec: 5, source: 'anchor.json' },
        lastGateAt: null,
        halted: false,
        source: 'anchor.json + gate-events.jsonl',
      },
    ],
  };
  const statusDocument = {
    at,
    service: { pid: 1, tick: 9, at, ageSec: 5, alive: true, lastTickMs: 2_000, projects: 1, errors: 0 },
    halted: null,
    projects: [
      {
        projectId: FLEET_PROJECT_ID,
        root: '/data/home/yale/work/claudecodeui',
        snapshot: true,
        observedAt: at,
        counts: { todo: 0, ready: 0, 'needs-human': 0, done: 1, superseded: 0 },
        anchorAlive: true,
        drivers: {
          worker: { state: 'ok', ageSec: 5 },
          promotion: { state: 'ok', ageSec: 5 },
          goal: { state: 'ok', ageSec: 5 },
          outer: { state: 'ok', ageSec: 5 },
        },
      },
    ],
  };

  const makeReader = (documents: { liveness?: unknown; status?: unknown }) =>
    createQuayFleetLivenessReader({
      locate: () => ({ binPath: '/stubbed/quay-fleet' }),
      exec: async (_file, args) => {
        const verb = args[0];
        const document = verb === 'liveness' ? documents.liveness : documents.status;
        return document === undefined
          ? { ok: false, code: 2, stdout: '', stderr: `${verb} not available` }
          : { ok: true, code: 0, stdout: JSON.stringify(document), stderr: '' };
      },
    });

  const fromLiveness = await makeReader({ liveness: livenessDocument }).read();
  const fromStatus = await makeReader({ status: statusDocument }).read();
  assert.equal(fromLiveness.source, 'liveness');
  assert.equal(fromStatus.source, 'status');
  assert.deepEqual(fromLiveness.projects, fromStatus.projects);

  const livenessReading = build({ liveness: fromLiveness });
  const statusReading = build({ liveness: fromStatus });
  assert.deepEqual(statusReading.digest.layers, livenessReading.digest.layers);
  assert.deepEqual(statusReading.deltaItems, livenessReading.deltaItems);
  assert.equal(statusReading.status.state, 'ok');
});

test('AC2: a fleet with no binary answers unavailable with one reason instead of throwing', async () => {
  const reader = createQuayFleetLivenessReader({
    locate: () => ({ binPath: null }),
    exec: async () => {
      throw new Error('must not be called when no binary was located');
    },
  });
  const reading = await reader.read();
  assert.equal(reading.available, false);
  assert.equal(reading.source, 'none');
  assert.equal(reading.projects.length, 0);
  assert.match(String(reading.reason), /quay-fleet 不可用/);
});

