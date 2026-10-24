/**
 * Criterion for the start-up resident restore pass (gap-resident-restore-after-restart).
 *
 * A restart drops every resident process the previous server held. The sessions
 * stay stored as resident, but nothing is serving them until the next
 * `chat.send` lazily opens one — which leaves cross-session peer addressing
 * (`SendMessage` by `peerName`) pointing at a session nobody is serving. The
 * pass under test brings the most recently active ones back at boot, on by
 * default (an operator opts out from the settings file).
 *
 * The claim has three parts, read in order:
 *
 *   (1) the configuration face: the generic SERVER-level settings file decides
 *       the switch — `residentRestore.enabled` is on unless the file sets it
 *       false — and a malformed `max` / `maxAgeMs` (or a file that cannot be
 *       read) falls back to the shipped default with the reason in `problems`
 *       instead of throwing, because a knob that could throw would take the
 *       whole boot down. `SERVER_SETTINGS_PATH` names the file; there are no
 *       per-key environment variables;
 *   (2) the selection itself: only restorable sessions are started, most
 *       recently active first, capped by the ceiling, stale rows declined, and
 *       one launch that rejects does not stop the ones behind it nor reject the
 *       pass;
 *   (3) the store's own candidate query, driven on a temporary database: it
 *       filters archived / non-resident / provider-id-less rows, orders by
 *       `COALESCE(updated_at, created_at)` descending with `session_id` as the
 *       tiebreak, applies the activity window, and honours the limit.
 *
 * What is real and what is substituted: the store query in (3) runs against a
 * real SQLite database written by `initializeDatabase()`. The pass in (2) runs
 * over an injected reader and launch seam — the same two seams `server/index.ts`
 * supplies — so the selection can be driven over candidates a real database
 * cannot be made to produce on demand. The launch seam is a function that
 * records its calls; no process is spawned, because a criterion about which
 * sessions a pass picks has no business starting models.
 *
 * Falsification: a pass that trusted its reader's ordering reds (2)'s order
 * assertion; one that started every candidate reds the ceiling; one that let a
 * rejection escape reds the isolation case; a query missing any of the three
 * WHERE clauses reds (3)'s exclusion set.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { SERVER_SETTINGS_ENV, loadServerSettings } from '@/modules/settings/index.js';
import type { IProviderHostDriver } from '@/shared/interfaces.js';
import type { HostResidentStartResult, LLMProvider } from '@/shared/types.js';

import {
  DEFAULT_RESIDENT_RESTORE_ENABLED,
  DEFAULT_RESIDENT_RESTORE_MAX,
  DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS,
  createResidentRestoreService,
} from '../resident-restore.service.js';
import type { RestorableResidentSession } from '../resident-restore.service.js';
import { RESIDENT_IDLE_TIMEOUT } from '../session-host-manager.service.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * A driver that can be asked to open a session's resident process.
 *
 * Only the on-demand verb is present because it is the only property the pass
 * reads: "the provider mounts a resident driver" is that one function being
 * callable, exactly as `startResidentHost` reads it.
 */
const RESIDENT_DRIVER = {
  async startResidentSession(): Promise<HostResidentStartResult> {
    return { hostId: 'unused', pid: null };
  },
} as unknown as IProviderHostDriver;

/**
 * A driver that mounts no on-demand verb.
 *
 * The pass must decline its sessions rather than hand them to the launch seam —
 * the seam would assemble launch options for a driver that cannot receive them.
 */
const DRIVER_WITHOUT_ONDEMAND = {} as unknown as IProviderHostDriver;

/** The two providers this file uses; `claude` mounts the resident driver. */
const RESIDENT_PROVIDER: LLMProvider = 'claude';
const OTHER_PROVIDER: LLMProvider = 'codex';

/**
 * Runs the pass over the given candidates with a launch seam that records calls.
 *
 * `failOn` names one app session id whose launch rejects — the isolation case.
 * The reader answers everything it is handed and ignores the query, which is
 * deliberate: the pass is the thing that must apply the window and the ceiling,
 * so a reader that already filtered would make this criterion vacuous.
 */
async function runPass(options: {
  candidates: RestorableResidentSession[];
  now: number;
  max?: number;
  maxAgeMs?: number;
  failOn?: string;
  drivers?: Partial<Record<LLMProvider, IProviderHostDriver | null>>;
}): Promise<{
  calls: Array<{ provider: LLMProvider; appSessionId: string }>;
  queries: Array<{ maxAgeMs: number; limit: number }>;
  outcome: Awaited<ReturnType<ReturnType<typeof createResidentRestoreService>['restore']>>;
  logs: string[];
}> {
  const calls: Array<{ provider: LLMProvider; appSessionId: string }> = [];
  const queries: Array<{ maxAgeMs: number; limit: number }> = [];
  const logs: string[] = [];
  const drivers = options.drivers ?? { [RESIDENT_PROVIDER]: RESIDENT_DRIVER };

  const service = createResidentRestoreService({
    listRestorableResidentSessions: (query) => {
      queries.push(query);
      return options.candidates;
    },
    resolveHostDriver: (provider) => drivers[provider] ?? null,
    startResidentSession: async (provider, appSessionId) => {
      calls.push({ provider, appSessionId });
      if (options.failOn === appSessionId) {
        throw new Error(`launch refused for ${appSessionId}`);
      }
      return { hostId: `host-${appSessionId}`, pid: 4242 };
    },
    max: options.max,
    maxAgeMs: options.maxAgeMs,
    now: () => options.now,
    log: (message) => logs.push(message),
  });

  const outcome = await service.restore();
  return { calls, queries, outcome, logs };
}

/** One candidate, most of whose fields are the same in every case. */
function candidate(
  appSessionId: string,
  lastActiveAt: number,
  overrides: Partial<RestorableResidentSession> = {},
): RestorableResidentSession {
  return {
    appSessionId,
    provider: RESIDENT_PROVIDER,
    providerSessionId: `provider-${appSessionId}`,
    lastActiveAt,
    ...overrides,
  };
}

// ---------------------------
//----------------- (1) THE SERVER SETTINGS FILE ------------
test('AC1: the settings file decides the switch; malformed values fall back with a problem', async () => {
  // The public name is pinned here as the contract: a rename the implementation
  // makes alone must show up as a red reading, not as a test that follows the
  // code. It is the ONLY environment entry — there are no per-key variables.
  assert.equal(SERVER_SETTINGS_ENV, 'SERVER_SETTINGS_PATH');

  // The shipped defaults, and the one equality that keeps the window honest: it
  // is the resident idle ceiling itself, so "alive before the restart" cannot
  // drift from the lifetime policy.
  assert.equal(DEFAULT_RESIDENT_RESTORE_ENABLED, true);
  assert.equal(DEFAULT_RESIDENT_RESTORE_MAX, 16);
  assert.equal(DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS, 24 * HOUR_MS);
  assert.equal(DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS, 86_400_000);
  assert.equal(DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS, RESIDENT_IDLE_TIMEOUT);

  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'resident-restore-settings-'));
  try {
    const absentUserCopy = path.join(tempDirectory, 'no-user-copy', 'server.settings.json');
    const shippedPolicy = {
      enabled: DEFAULT_RESIDENT_RESTORE_ENABLED,
      max: DEFAULT_RESIDENT_RESTORE_MAX,
      maxAgeMs: DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS,
    };

    // (a) Nothing configured: the shipped defaults, on, and NOT a problem —
    // an absent user copy is the normal state, not a bad configuration.
    const shipped = loadServerSettings({ env: {}, defaultPath: absentUserCopy });
    console.log(`restore-settings shipped=${JSON.stringify(shipped)}`);
    assert.deepEqual(shipped.residentRestore, shippedPolicy);
    assert.equal(shipped.source, 'default');
    assert.deepEqual(shipped.problems, []);

    // (b) The file's `residentRestore.enabled` is what decides the pass; the
    // two numeric keys are read from the same block.
    const enabledPath = path.join(tempDirectory, 'enabled.json');
    await writeFile(
      enabledPath,
      JSON.stringify({ residentRestore: { enabled: true, max: 4, maxAgeMs: 60_000 } }),
    );
    const enabled = loadServerSettings({ settingsPath: enabledPath });
    console.log(`restore-settings enabled=${JSON.stringify(enabled)}`);
    assert.deepEqual(enabled.residentRestore, { enabled: true, max: 4, maxAgeMs: 60_000 });
    assert.equal(enabled.source, 'file');
    assert.deepEqual(enabled.problems, []);

    // (c) The opt-out: `enabled: false` turns off a pass that ships on, and the
    // reading is explicit — not a fallback. Without this case "on by default"
    // would be a claim nothing could refute from the file's side.
    const optedOutPath = path.join(tempDirectory, 'opted-out.json');
    await writeFile(
      optedOutPath,
      JSON.stringify({ residentRestore: { enabled: false, max: 4, maxAgeMs: 60_000 } }),
    );
    const optedOut = loadServerSettings({ settingsPath: optedOutPath });
    console.log(`restore-settings opted-out=${JSON.stringify(optedOut)}`);
    assert.deepEqual(optedOut.residentRestore, { enabled: false, max: 4, maxAgeMs: 60_000 });
    assert.equal(optedOut.source, 'file');
    assert.deepEqual(optedOut.problems, []);

    // (d) Unknown keys — top-level and inside the block — are ignored: a file
    // written for a newer build must not stop this one from booting.
    const unknownPath = path.join(tempDirectory, 'unknown.json');
    await writeFile(
      unknownPath,
      JSON.stringify({ futureKnob: 1, residentRestore: { enabled: true, futureKnob: 'x' } }),
    );
    const unknown = loadServerSettings({ settingsPath: unknownPath });
    assert.equal(unknown.residentRestore.enabled, true);
    assert.equal(unknown.residentRestore.max, DEFAULT_RESIDENT_RESTORE_MAX);
    assert.deepEqual(unknown.problems, []);

    // (e) Malformed values fall back FIELD BY FIELD and are reported: a typo in
    // `max` must not silently turn off a pass the operator explicitly enabled.
    const malformedPath = path.join(tempDirectory, 'malformed.json');
    await writeFile(
      malformedPath,
      JSON.stringify({ residentRestore: { enabled: 'yes', max: 0, maxAgeMs: 2.5 } }),
    );
    const malformed = loadServerSettings({ settingsPath: malformedPath });
    console.log(`restore-settings malformed=${JSON.stringify(malformed)}`);
    assert.deepEqual(malformed.residentRestore, shippedPolicy);
    assert.equal(malformed.problems.length, 3, `every malformed field must be reported: ${JSON.stringify(malformed.problems)}`);
    assert.ok(malformed.problems.some((problem) => problem.includes('residentRestore.enabled')));
    assert.ok(malformed.problems.some((problem) => problem.includes('residentRestore.max')));
    assert.ok(malformed.problems.some((problem) => problem.includes('residentRestore.maxAgeMs')));

    // A block that is not an object cannot be read field by field, so every
    // default stays and the reason names the block.
    const blockPath = path.join(tempDirectory, 'block.json');
    await writeFile(blockPath, JSON.stringify({ residentRestore: 'on' }));
    const block = loadServerSettings({ settingsPath: blockPath });
    assert.deepEqual(block.residentRestore, shippedPolicy);
    assert.deepEqual(block.problems, ['`residentRestore` must be a JSON object']);

    // (f) SERVER_SETTINGS_PATH is the escape hatch: it names the file the
    // reading consults, and an EXPLICITLY named file that cannot be read is a
    // problem (unlike the absent user copy above).
    const viaEnv = loadServerSettings({
      env: { [SERVER_SETTINGS_ENV]: enabledPath },
      defaultPath: absentUserCopy,
    });
    assert.equal(viaEnv.residentRestore.enabled, true);

    const missing = loadServerSettings({
      env: { [SERVER_SETTINGS_ENV]: path.join(tempDirectory, 'missing.json') },
    });
    console.log(`restore-settings missing=${JSON.stringify(missing)}`);
    assert.deepEqual(missing.residentRestore, shippedPolicy);
    assert.equal(missing.problems.length, 1);
    assert.match(missing.problems[0], /could not read/);

    const invalidJsonPath = path.join(tempDirectory, 'invalid.json');
    await writeFile(invalidJsonPath, '{ not json');
    const invalidJson = loadServerSettings({ env: { [SERVER_SETTINGS_ENV]: invalidJsonPath } });
    console.log(`restore-settings invalid-json=${JSON.stringify(invalidJson)}`);
    assert.deepEqual(invalidJson.residentRestore, shippedPolicy);
    assert.equal(invalidJson.problems.length, 1);
    assert.match(invalidJson.problems[0], /not valid JSON/);

    // A JSON document that is not an object is refused whole as well.
    const arrayPath = path.join(tempDirectory, 'array.json');
    await writeFile(arrayPath, '[]');
    const arrayDocument = loadServerSettings({ settingsPath: arrayPath });
    assert.deepEqual(arrayDocument.residentRestore, shippedPolicy);
    assert.equal(arrayDocument.problems.length, 1);
    assert.match(arrayDocument.problems[0], /must contain a JSON object/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// ---------------------------
//----------------- (2) SELECTION ------------
test('AC2: the pass restores resident sessions most-recent-first, capped, stale rows skipped', async () => {
  const now = 1_800_000_000_000;
  // Deliberately out of order and longer than the ceiling: the pass, not the
  // reader, must sort and truncate.
  const candidates = [
    candidate('middle', now - 6 * HOUR_MS),
    candidate('newest', now - 1 * HOUR_MS),
    candidate('third', now - 12 * HOUR_MS),
    candidate('older-but-inside-window', now - 20 * HOUR_MS),
  ];

  const { calls, queries, outcome, logs } = await runPass({ candidates, now, max: 2 });
  console.log(
    `restore-select started=${calls.map((call) => call.appSessionId).join(',')} ` +
      `skipped=${outcome.skipped.map((entry) => `${entry.appSessionId}:${entry.reason}`).join(',') || 'none'} ` +
      `considered=${outcome.considered} queries=${JSON.stringify(queries)}`,
  );

  // The query carried the pass's own window and ceiling down to the reader.
  assert.deepEqual(queries, [{ maxAgeMs: DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS, limit: 2 }]);
  assert.equal(outcome.considered, 4);
  // Most recent first, then truncated by the ceiling: `newest` (1h) and
  // `middle` (6h) — not the reader's order, and not all four.
  assert.deepEqual(calls.map((call) => call.appSessionId), ['newest', 'middle']);
  assert.deepEqual(calls.map((call) => call.provider), [RESIDENT_PROVIDER, RESIDENT_PROVIDER]);
  assert.deepEqual(
    outcome.started.map((entry) => entry.appSessionId),
    ['newest', 'middle'],
  );
  assert.equal(outcome.failed.length, 0);
  assert.equal(outcome.budgetExhausted, false);
  assert.ok(
    logs.some((line) => line.includes('considered=4') && line.includes('started=2')),
    `the pass must log a summary; got ${JSON.stringify(logs)}`,
  );
});

test('AC2: a stale row, a row without a provider session, and a driverless provider are skipped', async () => {
  const now = 1_800_000_000_000;
  const candidates = [
    candidate('fresh', now - 1 * HOUR_MS),
    candidate('stale', now - 30 * HOUR_MS),
    candidate('no-provider-id', now - 2 * HOUR_MS, { providerSessionId: null }),
    candidate('driverless', now - 3 * HOUR_MS, { provider: OTHER_PROVIDER }),
    candidate('no-ondemand-verb', now - 4 * HOUR_MS, { provider: OTHER_PROVIDER }),
  ];

  const { calls, outcome } = await runPass({
    candidates,
    now,
    drivers: {
      [RESIDENT_PROVIDER]: RESIDENT_DRIVER,
      [OTHER_PROVIDER]: DRIVER_WITHOUT_ONDEMAND,
    },
  });
  console.log(
    `restore-skip started=${calls.map((call) => call.appSessionId).join(',')} ` +
      `skipped=${outcome.skipped.map((entry) => `${entry.appSessionId}:${entry.reason}`).join(',')}`,
  );

  assert.deepEqual(calls.map((call) => call.appSessionId), ['fresh']);
  // Reported in the pass's own order — most recently active first — so a reader
  // can tell the pass walked the ordered list rather than the reader's.
  assert.deepEqual(outcome.skipped, [
    { appSessionId: 'no-provider-id', reason: 'no-provider-session' },
    { appSessionId: 'driverless', reason: 'no-resident-driver' },
    { appSessionId: 'no-ondemand-verb', reason: 'no-resident-driver' },
    { appSessionId: 'stale', reason: 'stale' },
  ]);
});

test('AC2: one rejected launch is isolated — the rest still run and the pass does not reject', async () => {
  const now = 1_800_000_000_000;
  const candidates = [
    candidate('first', now - 1 * HOUR_MS),
    candidate('broken', now - 2 * HOUR_MS),
    candidate('third', now - 3 * HOUR_MS),
  ];

  const { calls, outcome } = await runPass({ candidates, now, failOn: 'broken' });
  console.log(
    `restore-isolation calls=${calls.map((call) => call.appSessionId).join(',')} ` +
      `started=${outcome.started.map((entry) => entry.appSessionId).join(',')} ` +
      `failed=${outcome.failed.map((entry) => `${entry.appSessionId}:${entry.reason}`).join(',')}`,
  );

  // The broken launch did not stop the one behind it.
  assert.deepEqual(calls.map((call) => call.appSessionId), ['first', 'broken', 'third']);
  assert.deepEqual(
    outcome.started.map((entry) => entry.appSessionId),
    ['first', 'third'],
  );
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].appSessionId, 'broken');
  assert.match(outcome.failed[0].reason, /launch refused for broken/);
});

// ---------------------------
//----------------- (3) THE STORE'S CANDIDATE QUERY ------------
/** SQLite's own timestamp form, the shape `CURRENT_TIMESTAMP` writes. */
function sqliteTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Writes one session row straight into the temporary database.
 *
 * Straight SQL rather than a repository method because the fixture has to name
 * the exact `updated_at` each row should carry — the subject of the query is how
 * those timestamps are filtered and ordered, so a fixture that could only say
 * "now" would not be able to ask the question.
 */
const FIXTURE_PROJECT_PATH = '/tmp/resident-restore-criterion';

function insertSessionRow(row: {
  sessionId: string;
  provider?: string;
  providerSessionId?: string | null;
  lifecycleMode?: string;
  isArchived?: number;
  createdAt: number;
  updatedAt: number | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO sessions
         (session_id, provider, provider_session_id, project_path, jsonl_path,
          model, effort, permission_mode, lifecycle_mode, forked_from_session_id,
          isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
    )
    .run(
      row.sessionId,
      row.provider ?? 'claude',
      row.providerSessionId === undefined ? `provider-${row.sessionId}` : row.providerSessionId,
      FIXTURE_PROJECT_PATH,
      row.lifecycleMode ?? 'resident',
      row.isArchived ?? 0,
      sqliteTimestamp(row.createdAt),
      row.updatedAt === null ? null : sqliteTimestamp(row.updatedAt),
    );
}

test('AC3: listRestorableResidentSessions filters, orders, windows and limits on a real database', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'resident-restore-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    // The sessions table has a foreign key onto `projects`; the fixture project
    // is the one every inserted row points at.
    projectsDb.createProjectPath(FIXTURE_PROJECT_PATH);
    const now = Date.now();
    insertSessionRow({ sessionId: 'newest', createdAt: now - 2 * HOUR_MS, updatedAt: now - 1 * HOUR_MS });
    insertSessionRow({ sessionId: 'middle', createdAt: now - 8 * HOUR_MS, updatedAt: now - 6 * HOUR_MS });
    insertSessionRow({ sessionId: 'old-inside-window', createdAt: now - 21 * HOUR_MS, updatedAt: now - 20 * HOUR_MS });
    // Outside the 24h window: the session was already idle past the resident
    // ceiling before the restart, so it must not be restored.
    insertSessionRow({ sessionId: 'stale', createdAt: now - 40 * HOUR_MS, updatedAt: now - 30 * HOUR_MS });
    // Archived, non-resident, and provider-id-less rows — each excluded by one
    // of the three WHERE clauses, and each recent enough to be otherwise eligible.
    insertSessionRow({ sessionId: 'archived', createdAt: now - 3 * HOUR_MS, updatedAt: now - 2 * HOUR_MS, isArchived: 1 });
    insertSessionRow({ sessionId: 'per-run', createdAt: now - 3 * HOUR_MS, updatedAt: now - 2 * HOUR_MS, lifecycleMode: 'per-run' });
    insertSessionRow({ sessionId: 'no-provider-id', createdAt: now - 3 * HOUR_MS, updatedAt: now - 2 * HOUR_MS, providerSessionId: null });
    // `updated_at` NULL: the row falls back to `created_at`, the same COALESCE
    // the recent-sessions page orders by.
    insertSessionRow({ sessionId: 'null-updated', createdAt: now - 4 * HOUR_MS, updatedAt: null });
    // A tie on activity, broken by `session_id DESC`.
    insertSessionRow({ sessionId: 'tie-a', createdAt: now - 5 * HOUR_MS, updatedAt: now - 5 * HOUR_MS });
    insertSessionRow({ sessionId: 'tie-b', createdAt: now - 5 * HOUR_MS, updatedAt: now - 5 * HOUR_MS });

    const windowMs = 24 * HOUR_MS;
    const ordered = sessionsDb.listRestorableResidentSessions({ maxAgeMs: windowMs, limit: 20 });
    console.log(
      `restore-db ordered=${ordered
        .map((row) => `${row.appSessionId}@${row.lastActiveAt}`)
        .join(',')}`,
    );

    assert.deepEqual(
      ordered.map((row) => row.appSessionId),
      ['newest', 'null-updated', 'tie-b', 'tie-a', 'middle', 'old-inside-window'],
      'the query must exclude archived / non-resident / provider-id-less / stale rows, ' +
        'order by activity descending with session_id DESC as the tiebreak, and fall back to created_at',
    );

    // `lastActiveAt` is a real epoch-ms reading of the activity instant, within
    // the second the timestamp form keeps.
    assert.ok(Math.abs(ordered[0].lastActiveAt - (now - 1 * HOUR_MS)) < 1_000);
    assert.equal(ordered[0].provider, 'claude');
    assert.equal(ordered[0].providerSessionId, 'provider-newest');

    const limited = sessionsDb.listRestorableResidentSessions({ maxAgeMs: windowMs, limit: 2 });
    console.log(`restore-db limited=${limited.map((row) => row.appSessionId).join(',')}`);
    assert.deepEqual(limited.map((row) => row.appSessionId), ['newest', 'null-updated']);

    // A shorter window moves the boundary: at 7 hours only the two most recent
    // rows are still inside it.
    const narrow = sessionsDb.listRestorableResidentSessions({ maxAgeMs: 7 * HOUR_MS, limit: 20 });
    console.log(`restore-db narrow=${narrow.map((row) => row.appSessionId).join(',')}`);
    assert.deepEqual(narrow.map((row) => row.appSessionId), [
      'newest',
      'null-updated',
      'tie-b',
      'tie-a',
      'middle',
    ]);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
