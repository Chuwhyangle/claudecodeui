/**
 * Cross-repository contract tests: CloudCLI against the INSTALLED quay-fleet.
 *
 * WHAT THIS FILE PROVES. Every `quay-fleet` invocation CloudCLI consumes is run against the real
 * binary on this host, and its JSON answer is checked against the declaration in `shapes.ts`.
 * The handshake goes first: if the fleet declares a contract this build does not speak, the run
 * reds and names the contract instead of exercising verbs whose output may have moved under us.
 *
 * WHY IT IS FAIL-CLOSED. A host without the fleet is a RED, not a skip: a contract test that
 * silently skips on the machine that would have caught the break protects nothing. The explicit
 * `CONTRACT_TESTS_ALLOW_MISSING_FLEET=1` switch exists for hosts that genuinely have no fleet
 * (CI without a release); when set, the file reports ONE skipped case whose reason says exactly
 * what is not being checked.
 *
 * THE OPERATOR'S FLEET HOME IS READ-ONLY TO THIS FILE. Read-only verbs run against the configured
 * home (they cannot write it). The two writing verbs — `registry interface-session set|clear` —
 * are run against a `QUAY_FLEET_HOME` created with `mkdtempSync` under the OS temp directory, and
 * `assertTemporaryHome` refuses to spawn them otherwise. The AC4 guard then re-stamps the real
 * home's `registry.json` and reds if its mtime/size moved: that file is the only durable target
 * of the exercised verbs, while the rest of the home belongs to the resident fleet service and is
 * rewritten every tick by the service itself (guarding those would make the test flaky, not
 * safe).
 *
 * RUNNER NOTE: a server test, run through `tsx --test` (see `scripts/test.sh`); vitest's include
 * is `src/**` and would find no tests here.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  createQuayFleetCliReader,
  locateQuayFleetCli,
  QUAY_FLEET_SUPPORTED_CONTRACTS,
} from '../../quay-fleet-locator.js';

import {
  FLEET_CLI_CONTRACTS,
  INITIATIVE_SHOW_SHAPE,
  validateShape,
  WALL_RESOLVE_SHAPE,
  type FleetCliContract,
  type FleetCliContractContext,
  type Shape,
} from './shapes.js';

/** The checkout this test lives in — used as the project root a temporary fleet home registers. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');

/** The opt-out for hosts that genuinely have no fleet; see the file comment. */
const ALLOW_MISSING_FLEET = process.env.CONTRACT_TESTS_ALLOW_MISSING_FLEET === '1';

/** Per-invocation wall clock. `status` performs a live session probe, so this stays generous. */
const COMMAND_TIMEOUT_MS = 30_000;

/** A `status` document is small; this only bounds a runaway child. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A syntactically valid task id. `wall resolve` parses the URI and never dereferences the id. */
const PROBE_TASK_ID = 'contract-probe-task';

/** The id a writing contract pins (the fleet validates the shape of session ids, not this value). */
const PROBE_SESSION_ID = '11111111-1111-4111-8111-111111111111';

/** The project id used when the real registry has no usable row (a temporary home is seeded). */
const FALLBACK_PROJECT_ID = 'claudecodeui';

/** The initiative the WRITING contracts create (and then decide) inside a temporary home. */
const PROBE_INITIATIVE_SLUG = 'contract-probe-initiative';

/**
 * A charter the fleet accepts verbatim, passed as one argv element (execFile, no shell).
 * `create` only ever runs against a temporary home, so this never lands in the operator's store.
 */
const PROBE_INITIATIVE_CHARTER = JSON.stringify({
  intent: 'contract probe: exercise the initiative CLI shapes',
  projects: [FALLBACK_PROJECT_ID],
  completionCriteria: 'the create/decide answers validate against the declarations',
  grantScope: { mayDecide: ['task-split'], mustEscalate: ['release'] },
  exitConditions: 'the probe home is removed at the end of the run',
  expiresAt: '2026-12-31',
});

/** The fleet home the operator configured; `QUAY_FLEET_HOME` wins over the default. */
const REAL_FLEET_HOME = process.env.QUAY_FLEET_HOME?.trim() || path.join(os.homedir(), '.quay-fleet');

/** Temporary homes this file created; all are removed in the `after` hook. */
const temporaryHomes: string[] = [];

//----------------- process helpers ------------

/** One invocation's outcome, normalized so the assertions never see child-process internals. */
type FleetCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

type FleetExecError = Error & { code?: number | string | null; killed?: boolean };

/** Runs the installed fleet once. Never rejects: every failure is a result the caller reports. */
function runFleet(
  binPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<FleetCommandResult> {
  return new Promise((resolve) => {
    execFile(
      binPath,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true, env },
      (error: FleetExecError | null, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '', error: null });
          return;
        }
        const reason = error.killed === true
          ? `timed out after ${COMMAND_TIMEOUT_MS}ms`
          : error.code === 'ENOENT'
            ? `binary could not be spawned: ${binPath}`
            : `exited ${typeof error.code === 'number' ? `with ${error.code}` : 'without a status'}`;
        resolve({
          ok: false,
          code: typeof error.code === 'number' ? error.code : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: reason,
        });
      },
    );
  });
}

/** Parses stdout as a JSON object, or `null` when the child printed something else. */
function parseJsonDocument(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

//----------------- shape helpers ------------

/** Asserts one document satisfies one declaration, naming the drifted path on failure. */
function assertShape(label: string, value: unknown, shape: Shape): void {
  const violation = validateShape(value, shape);
  assert.equal(
    violation,
    null,
    violation === null ? `${label}: shape ok` : `${label}: ${violation.path}: ${violation.message}`,
  );
}

/**
 * Returns a copy of an object declaration with one required field RENAMED.
 * The AC2 control arm uses this to prove a declaration typo reds and names the field: the
 * installed fleet's answer cannot carry the renamed key, so the copied declaration must fail.
 */
function renameRequiredField(shape: Shape, from: string, to: string): Shape {
  if (shape.type !== 'object') return shape;
  const fields: Record<string, Shape> = {};
  for (const [name, field] of Object.entries(shape.fields)) {
    fields[name === from ? to : name] = field;
  }
  return { ...shape, fields };
}

//----------------- fleet-home helpers ------------

/**
 * Seeds a temporary fleet home whose registry names this checkout, so writing verbs (and read
 * verbs on a host with no real registry) have a real project to address. The operator's home is
 * never written.
 */
function createTemporaryFleetHome(projectId: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-fleet-contract-'));
  temporaryHomes.push(home);
  fs.writeFileSync(
    path.join(home, 'registry.json'),
    `${JSON.stringify({ version: 1, projects: [{ id: projectId, root: REPO_ROOT, enabled: true }] }, null, 2)}\n`,
  );
  return home;
}

/**
 * Structural guard for the writing contracts: they may only ever target a temp home. Asserting
 * here (rather than trusting the call sites) is what keeps a future edit from pointing a write at
 * the operator's real fleet home.
 */
function assertTemporaryHome(contract: FleetCliContract, env: NodeJS.ProcessEnv): void {
  const configured = env.QUAY_FLEET_HOME?.trim();
  assert.ok(configured !== undefined && configured !== '',
    `${contract.id} writes the fleet home; it must be given an explicit QUAY_FLEET_HOME`);
  const relative = path.relative(os.tmpdir(), configured);
  assert.ok(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${contract.id} writes the fleet home; ${configured} is not under ${os.tmpdir()}`);
}

/** The AC4 reading of the operator's fleet home: the one file the exercised verbs can write. */
type RegistryStamp = {
  file: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
};

function stampRealRegistry(): RegistryStamp {
  const file = path.join(REAL_FLEET_HOME, 'registry.json');
  try {
    const stat = fs.statSync(file);
    return { file, exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { file, exists: false, mtimeMs: null, size: null };
  }
}

//----------------- whole-home stamp (AC3) ------------

/** One regular file's identity for AC3: its mtime alone would miss a same-timestamp rewrite. */
type HomeFileStamp = { mtimeMs: number; size: number };

/**
 * The files the RESIDENT fleet service rewrites on its own schedule.
 *
 * AC3 says the home's files must not move during the run. Taken literally that is a race with the
 * service: it rewrites `heartbeat.json` and its ledgers every 60s tick, so a literal whole-home
 * assertion would red roughly once every dozen runs without anything in this suite being wrong.
 * The guard therefore EXEMPTS exactly these service-owned files and requires every other file —
 * including `registry.json`, `initiatives.json` and the decision ledger — to stay identical.
 * `ledgers/` and `acceptance-windows/` are wholly service/operator written, so they are matched by
 * prefix; the initiative decision ledger is checked separately below.
 */
const RESIDENT_SERVICE_FILES = new Set([
  'attention.json',
  'bridge-deliveries.v0.json',
  'decisions.jsonl',
  'events.jsonl',
  'filter-state.json',
  'heartbeat.json',
  'inbox.lock',
  'last-snapshot.json',
  'needs-human-autoresume-log.jsonl',
  'needs-human-autoresume-resume-cap.json',
  'notification-bridge.v0.json',
  'notification-pipeline.v0.json',
  'outbox.jsonl',
  'phases.jsonl',
  'receipts.jsonl',
  'resolution-cases.jsonl',
  'service.out',
  'service.pid',
  'state.json',
  'wake-state.json',
]);

function isResidentServiceFile(file: string): boolean {
  return RESIDENT_SERVICE_FILES.has(file)
    || file.startsWith('ledgers/')
    || file.startsWith('acceptance-windows/');
}

/** Every regular file under the fleet home, keyed by relative path. */
function stampFleetHome(home: string): Map<string, HomeFileStamp> {
  const stamps = new Map<string, HomeFileStamp>();
  const walk = (directory: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(absolute);
          stamps.set(relative, { mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Vanished between readdir and stat — simply not stamped.
        }
      }
    }
  };
  walk(home, '');
  return stamps;
}

/** The project row a read contract addresses; `root` must exist because `wall summary` opens it. */
type RegistryRow = { id: string; root: string };

function isUsableRegistryRow(value: unknown): value is RegistryRow {
  if (value === null || typeof value !== 'object') return false;
  const row = value as { id?: unknown; root?: unknown };
  if (typeof row.id !== 'string' || row.id === '' || typeof row.root !== 'string' || row.root === '') {
    return false;
  }
  try {
    return fs.statSync(row.root).isDirectory();
  } catch {
    return false;
  }
}

/** The first slug in an `initiative list --json` document, or `null` when it lists none. */
function firstInitiativeSlug(document: Record<string, unknown> | null): string | null {
  const rows = document?.initiatives;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const slug = (row as { slug?: unknown }).slug;
    if (typeof slug === 'string' && slug !== '') return slug;
  }
  return null;
}

/** Where the read contracts point: the operator's real registry when it has a usable row. */
type ReadContext = {
  context: FleetCliContractContext;
  env: NodeJS.ProcessEnv;
};

async function resolveReadContext(binPath: string): Promise<ReadContext> {
  const env = { ...process.env };

  // The read contracts address BOTH a project (registry row) and an initiative (slug). Each is a
  // reading of the operator's home; the shapes can only be exercised when both exist there.
  const [listed, initiatives] = await Promise.all([
    runFleet(binPath, ['registry', 'list', '--json'], env),
    runFleet(binPath, ['initiative', 'list', '--json'], env),
  ]);
  const rows = listed.ok ? parseJsonDocument(listed.stdout)?.projects : undefined;
  const row = Array.isArray(rows) ? rows.find(isUsableRegistryRow) : undefined;
  const slug = initiatives.ok ? firstInitiativeSlug(parseJsonDocument(initiatives.stdout)) : null;

  if (row !== undefined && slug !== null) {
    return {
      context: {
        project: row.id,
        projectRoot: row.root,
        taskId: PROBE_TASK_ID,
        sessionId: PROBE_SESSION_ID,
        initiativeSlug: slug,
        initiativeCharter: PROBE_INITIATIVE_CHARTER,
      },
      env,
    };
  }

  // No usable real registry row or no real initiative: seed a temporary home with BOTH so the
  // SHAPES are still exercised with the same verbs. Nothing of the operator's home is written.
  const home = createTemporaryFleetHome(FALLBACK_PROJECT_ID);
  const temporaryEnv: NodeJS.ProcessEnv = { ...process.env, QUAY_FLEET_HOME: home };
  const seeded = await runFleet(
    binPath,
    ['initiative', 'create', PROBE_INITIATIVE_SLUG, '--charter', PROBE_INITIATIVE_CHARTER, '--json'],
    temporaryEnv,
  );
  assert.equal(
    seeded.ok,
    true,
    `could not seed an initiative in ${home}; the initiative read contexts cannot be exercised — `
    + `${seeded.error ?? seeded.stderr.trim()}`,
  );
  return {
    context: {
      project: FALLBACK_PROJECT_ID,
      projectRoot: REPO_ROOT,
      taskId: PROBE_TASK_ID,
      sessionId: PROBE_SESSION_ID,
      initiativeSlug: PROBE_INITIATIVE_SLUG,
      initiativeCharter: PROBE_INITIATIVE_CHARTER,
    },
    env: temporaryEnv,
  };
}

//----------------- module setup ------------

const location = locateQuayFleetCli();
const binPath = location.binPath;

/** Captured BEFORE any fleet invocation so the AC4 guard covers the whole run. */
const registryStampBefore = stampRealRegistry();

/** Captured at the same moment; AC3 compares the whole real home against this at the end. */
const fleetHomeStampBefore = stampFleetHome(REAL_FLEET_HOME);

after(() => {
  for (const home of temporaryHomes) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const missingFleetReason = `quay-fleet was not found (checked QUAY_FLEET_BIN, PATH and ${path.join(REAL_FLEET_HOME, 'bin', 'quay-fleet')}); `
  + 'this contract suite is fail-closed because an unchecked contract is not a contract. '
  + 'Set CONTRACT_TESTS_ALLOW_MISSING_FLEET=1 only on a host that is known to have no fleet.';

if (binPath === null) {
  test('quay-fleet must be installed for the contract suite to run', (t) => {
    if (ALLOW_MISSING_FLEET) {
      t.skip(`CONTRACT_TESTS_ALLOW_MISSING_FLEET=1 — ${missingFleetReason}`);
      return;
    }
    assert.fail(missingFleetReason);
  });
} else {
  // The handshake comes FIRST: an incompatible fleet must red before any verb is exercised.
  const handshakeReader = createQuayFleetCliReader({
    locate: () => ({ binPath, source: 'env' }),
    supportedContracts: QUAY_FLEET_SUPPORTED_CONTRACTS,
    timeoutMs: COMMAND_TIMEOUT_MS,
    ttlMs: 0,
  });
  const handshake = await handshakeReader.read();
  const handshakeOk = handshake.state === 'ok';
  const handshakeSkip = `handshake did not pass: ${handshake.reason ?? handshake.state}`;

  const readContext = await resolveReadContext(binPath);
  const readContracts = FLEET_CLI_CONTRACTS.filter((contract) => !contract.writes);
  const writeContracts = FLEET_CLI_CONTRACTS.filter((contract) => contract.writes);

  test('handshake: the installed fleet speaks this build\'s contracts', (t) => {
    t.diagnostic(
      `quay-fleet ${handshake.version ?? '<no version>'} at ${handshake.binPath ?? binPath}; `
      + `contracts wallUri=${handshake.contracts?.wallUri ?? '<none>'} `
      + `registry=${handshake.contracts?.registry ?? '<none>'} `
      + `interfaceSession=${handshake.contracts?.interfaceSession ?? '<none>'}`,
    );
    assert.equal(handshake.state, 'ok', `quay-fleet handshake failed: ${handshake.reason ?? handshake.state}`);
    assert.deepEqual(handshake.contracts, QUAY_FLEET_SUPPORTED_CONTRACTS);
  });

  for (const contract of readContracts) {
    test(`contract: ${contract.id}`, { skip: handshakeOk ? false : handshakeSkip }, async (t) => {
      const argv = contract.argv(readContext.context);
      const result = await runFleet(binPath, argv, readContext.env);
      assert.equal(
        result.ok,
        true,
        `${contract.id}: quay-fleet ${argv.join(' ')} failed — ${result.error ?? result.stderr.trim()}`,
      );

      const document = parseJsonDocument(result.stdout);
      assert.notEqual(
        document,
        null,
        `${contract.id}: stdout was not a JSON object: ${result.stdout.slice(0, 300)}`,
      );
      assertShape(contract.id, document, contract.shape);

      // `wall resolve` was asked for the `#ac-<n>` form; validate the branch CloudCLI renders,
      // not merely its presence (the shape declaration already pins kind/index).
      if (contract.id === 'wall-resolve') {
        const fragment = document?.fragment as { kind?: unknown; index?: unknown } | undefined;
        assert.equal(fragment?.kind, 'ac', `${contract.id}: expected an ac fragment`);
        assert.equal(fragment?.index, 2, `${contract.id}: expected fragment index 2`);
      }

      t.diagnostic(`contract ${contract.id}: quay-fleet ${argv.join(' ')} — shape ok (${contract.consumer})`);
    });
  }

  test('writing contracts run only against a temporary fleet home', { skip: handshakeOk ? false : handshakeSkip }, async (t) => {
    const home = createTemporaryFleetHome(readContext.context.project);
    const env: NodeJS.ProcessEnv = { ...process.env, QUAY_FLEET_HOME: home };
    // The temporary home is empty, so the writing contracts address the probe initiative `create`
    // stores there — never the operator's real slug.
    const context: FleetCliContractContext = { ...readContext.context, initiativeSlug: PROBE_INITIATIVE_SLUG };

    for (const contract of writeContracts) {
      assertTemporaryHome(contract, env);
      const argv = contract.argv(context);
      const result = await runFleet(binPath, argv, env);
      assert.equal(
        result.ok,
        true,
        `${contract.id}: quay-fleet ${argv.join(' ')} failed on the temporary home — ${result.error ?? result.stderr.trim()}`,
      );

      const document = parseJsonDocument(result.stdout);
      assert.notEqual(
        document,
        null,
        `${contract.id}: stdout was not a JSON object: ${result.stdout.slice(0, 300)}`,
      );
      assertShape(`${contract.id} (temporary home)`, document, contract.shape);

      // The declared shape allows `string | null`; the VALUE is the verb's own contract.
      if (contract.id === 'registry-interface-session-set') {
        assert.equal(document?.interfaceSessionId, PROBE_SESSION_ID, `${contract.id}: the pin was not read back`);
      }
      if (contract.id === 'registry-interface-session-clear') {
        assert.equal(document?.interfaceSessionId, null, `${contract.id}: clear must leave nothing pinned`);
      }

      // The initiative write shapes are allowed to be permissive about members/edges; these are
      // the verb's own guarantees (a fresh initiative is empty, and `--by human` derives `fact`).
      if (contract.id === 'initiative-create') {
        const initiative = document?.initiative as Record<string, unknown> | undefined;
        assert.equal(initiative?.slug, PROBE_INITIATIVE_SLUG, `${contract.id}: the answer must name the created slug`);
        assert.equal(initiative?.status, 'active', `${contract.id}: a fresh initiative is active`);
        assert.deepEqual(initiative?.members, [], `${contract.id}: a fresh initiative has no members`);
        assert.deepEqual(initiative?.edges, [], `${contract.id}: a fresh initiative has no edges`);
      }
      if (contract.id === 'initiative-decide') {
        const decision = document?.decision as Record<string, unknown> | undefined;
        assert.equal(decision?.by, 'human', `${contract.id}: --by human must be read back`);
        assert.equal(decision?.kind, 'fact', `${contract.id}: --by human derives kind:fact`);
        assert.equal(decision?.chosen, 'yes', `${contract.id}: the chosen option must be read back`);
      }

      t.diagnostic(`contract ${contract.id}: quay-fleet ${argv.join(' ')} — shape ok on temporary home`);
    }

    // Read the temp home through the same `get` verb the cockpit uses: after clear, it must say
    // "nothing pinned". This is the read-after-write half the write shapes alone cannot show.
    const getContract = readContracts.find((contract) => contract.id === 'registry-interface-session-get');
    assert.ok(getContract !== undefined, 'the interface-session get contract must be declared');
    const getResult = await runFleet(binPath, getContract.argv(context), env);
    assert.equal(getResult.ok, true, `post-write get failed: ${getResult.error ?? getResult.stderr.trim()}`);
    const getDocument = parseJsonDocument(getResult.stdout);
    assertShape('registry-interface-session-get (temporary home)', getDocument, getContract.shape);
    assert.equal(getDocument?.interfaceSessionId, null, 'clear must be visible through get');

    // …and the initiative half through `show`: create + decide must be readable back as one
    // initiative with exactly the one decision the writing contract appended.
    const showContract = readContracts.find((contract) => contract.id === 'initiative-show');
    assert.ok(showContract !== undefined, 'the initiative-show contract must be declared');
    const showResult = await runFleet(binPath, showContract.argv(context), env);
    assert.equal(showResult.ok, true, `post-write initiative show failed: ${showResult.error ?? showResult.stderr.trim()}`);
    const showDocument = parseJsonDocument(showResult.stdout);
    assertShape('initiative-show (temporary home)', showDocument, showContract.shape);
    const shownInitiative = showDocument?.initiative as Record<string, unknown> | undefined;
    assert.equal(shownInitiative?.slug, PROBE_INITIATIVE_SLUG, 'create must be visible through show');
    assert.equal(
      Array.isArray(showDocument?.decisions) ? showDocument.decisions.length : 0,
      1,
      'the probe decision must be visible through show',
    );
  });

  test('control arm: a declaration with a renamed required field reds and names the field', async () => {
    const contract = readContracts.find((candidate) => candidate.id === 'wall-resolve');
    assert.ok(contract !== undefined, 'the wall-resolve contract must be declared');
    const argv = contract.argv(readContext.context);
    const result = await runFleet(binPath, argv, readContext.env);
    assert.equal(result.ok, true, `wall resolve failed: ${result.error ?? result.stderr.trim()}`);
    const document = parseJsonDocument(result.stdout);
    assert.notEqual(document, null, 'wall resolve did not print a JSON object');

    // In-test construction only: the shipping declaration is untouched.
    const mutated = renameRequiredField(WALL_RESOLVE_SHAPE, 'label', 'labelRenamed');
    const violation = validateShape(document, mutated);
    assert.notEqual(violation, null, 'a declaration whose required field was renamed must red');
    assert.match(
      violation?.path ?? '',
      /label/,
      `the violation must NAME the field, got ${violation?.path}: ${violation?.message}`,
    );
  });

  test('control arm: declaring wallUri v1 reds the handshake and names wallUri', { skip: handshake.contracts === null ? 'the fleet declared no contracts to compare' : false }, async () => {
    const fleetWallUri = handshake.contracts?.wallUri ?? QUAY_FLEET_SUPPORTED_CONTRACTS.wallUri;
    const mismatchedWallUri = fleetWallUri === 'v1' ? 'v2' : 'v1';
    const reader = createQuayFleetCliReader({
      locate: () => ({ binPath, source: 'env' }),
      supportedContracts: { ...QUAY_FLEET_SUPPORTED_CONTRACTS, wallUri: mismatchedWallUri },
      timeoutMs: COMMAND_TIMEOUT_MS,
      ttlMs: 0,
    });
    const reading = await reader.read();
    assert.equal(reading.state, 'incompatible', `a mismatched wallUri must be incompatible, got ${reading.state}`);
    assert.match(reading.reason ?? '', /wallUri/, `the reason must NAME wallUri, got: ${reading.reason}`);
    assert.match(reading.reason ?? '', new RegExp(mismatchedWallUri), 'the reason must carry the mismatched value');
  });

  test('control arm: an edge with no project segment reds and names the edge URI', async (t) => {
    const contract = readContracts.find((candidate) => candidate.id === 'initiative-show');
    assert.ok(contract !== undefined, 'the initiative-show contract must be declared');
    const argv = contract.argv(readContext.context);
    const result = await runFleet(binPath, argv, readContext.env);
    assert.equal(result.ok, true, `initiative show failed: ${result.error ?? result.stderr.trim()}`);
    const document = parseJsonDocument(result.stdout);
    assert.notEqual(document, null, 'initiative show did not print a JSON object');

    const initiative = (document?.initiative ?? {}) as Record<string, unknown>;
    const edges = Array.isArray(initiative.edges) ? (initiative.edges as Record<string, unknown>[]) : [];
    // In-test construction only: one edge rewritten to the superseded project-less form. When the
    // addressed home has no edges, a minimal one is supplied so the check is never vacuous.
    const probeEdge = edges[0] ?? {
      from: 'quay://probe-project/task/probe',
      to: 'quay://probe-project/task/other',
      kind: 'blocks',
    };
    const mutated = {
      ...document,
      initiative: { ...initiative, edges: [{ ...probeEdge, from: 'quay://task/x' }, ...edges.slice(1)] },
    };
    const violation = validateShape(mutated, INITIATIVE_SHOW_SHAPE);
    assert.notEqual(violation, null, 'an edge whose from lost its project segment must red');
    assert.match(
      violation?.path ?? '',
      /initiative\.edges\[0\]\.from/,
      `the violation must NAME the edge URI, got ${violation?.path}: ${violation?.message}`,
    );
    t.diagnostic(`control arm reds as required: ${violation?.path}: ${violation?.message}`);
  });

  test('control arm: an unknown decision kind reds and names the path', async (t) => {
    const contract = readContracts.find((candidate) => candidate.id === 'initiative-show');
    assert.ok(contract !== undefined, 'the initiative-show contract must be declared');
    const argv = contract.argv(readContext.context);
    const result = await runFleet(binPath, argv, readContext.env);
    assert.equal(result.ok, true, `initiative show failed: ${result.error ?? result.stderr.trim()}`);
    const document = parseJsonDocument(result.stdout);
    assert.notEqual(document, null, 'initiative show did not print a JSON object');

    const decisions = Array.isArray(document?.decisions) ? (document?.decisions as Record<string, unknown>[]) : [];
    // As above: a real row when the home has one, otherwise a minimal valid row, then one field
    // mutated in-test. The shipping declaration is never touched.
    const probeDecision = decisions[0] ?? {
      at: new Date().toISOString(),
      initiative: readContext.context.initiativeSlug,
      by: 'human',
      question: 'probe?',
      options: ['yes', 'no'],
      chosen: 'yes',
      rationale: 'probe',
      refs: [],
      kind: 'fact',
    };
    const mutated = { ...document, decisions: [{ ...probeDecision, kind: 'vibes' }, ...decisions.slice(1)] };
    const violation = validateShape(mutated, INITIATIVE_SHOW_SHAPE);
    assert.notEqual(violation, null, 'an unknown decision kind must red');
    assert.match(
      violation?.path ?? '',
      /decisions\[0\]\.kind/,
      `the violation must NAME the decision kind, got ${violation?.path}: ${violation?.message}`,
    );
    t.diagnostic(`control arm reds as required: ${violation?.path}: ${violation?.message}`);
  });

  test('AC4: the operator fleet home registry is untouched by the run', () => {
    const after = stampRealRegistry();
    assert.deepEqual(
      after,
      registryStampBefore,
      `the real fleet home's registry.json changed during the contract run — writing contracts must only run `
      + `against a temporary QUAY_FLEET_HOME. before=${JSON.stringify(registryStampBefore)} after=${JSON.stringify(after)}`,
    );
  });

  test('AC3: the operator fleet home is untouched by the run (resident-service files excepted)', (t) => {
    const after = stampFleetHome(REAL_FLEET_HOME);
    const moved: string[] = [];
    for (const [file, stamp] of after) {
      const before = fleetHomeStampBefore.get(file);
      if (before === undefined || before.mtimeMs !== stamp.mtimeMs || before.size !== stamp.size) {
        moved.push(file);
      }
    }
    for (const file of fleetHomeStampBefore.keys()) {
      if (!after.has(file)) moved.push(`${file} (removed)`);
    }
    const unexplained = moved.filter((file) => !isResidentServiceFile(file));

    t.diagnostic(moved.length === 0
      ? `no file under ${REAL_FLEET_HOME} moved during the run`
      : `moved during the run (resident-service files are exempt): ${moved.join(', ')}`);
    assert.deepEqual(
      unexplained,
      [],
      `files under ${REAL_FLEET_HOME} moved during the contract run and are not written by the resident `
      + `fleet service: ${unexplained.join(', ')}`,
    );

    // The three files a contract verb could have written must be untouched in the LITERAL sense —
    // even though no non-writing verb in this suite is supposed to write anything at all.
    for (const file of ['registry.json', 'initiatives.json', 'ledgers/initiative-decisions.jsonl']) {
      assert.deepEqual(
        after.get(file),
        fleetHomeStampBefore.get(file),
        `${file} changed during the contract run`,
      );
    }
  });
}
