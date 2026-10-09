// Invariant tests for scripts/mint-token.mjs.
//
// Each of the tool's six self-enforced invariants has exactly one NAMED case below; the rest are
// supporting readings. The database is a throwaway sqlite file built from the DDL in this file —
// the tool must not import anything from server/, so its tests cannot either.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import {
  MAX_TTL_MINUTES,
  OBSERVER_PREFIX,
  assertFreshSubject,
  assertNoServerSecret,
  assertTtlWithinCap,
  decodeClaims,
  mintObserverToken,
  observerUsername,
  readJwtSecret,
  revokeObserverSubject,
  signHs256,
} from './mint-token.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(HERE, 'mint-token.mjs');
const SECRET = 'test-secret-not-the-real-one';

// The `users` + `app_config` tables as server/modules/database/schema.ts declares them. Reproduced
// rather than imported on purpose: nothing in server/ is allowed to reference this tool, and the
// dependency is not allowed to run the other way either.
const SCHEMA_SQL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  is_active BOOLEAN DEFAULT 1,
  git_name TEXT,
  git_email TEXT,
  has_completed_onboarding BOOLEAN DEFAULT 0
);
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quay-mint-token-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

let dbSeq = 0;

/**
 * A fresh throwaway auth.db.
 * @param {{ secret?: string|null, users?: string[] }} [options]
 * @returns {{ path: string, db: import('better-sqlite3').Database }}
 */
function makeDb(options = {}) {
  dbSeq += 1;
  const dbPath = path.join(TMP, `auth-${dbSeq}.db`);
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  if (options.secret !== null) {
    db.prepare("INSERT INTO app_config (key, value) VALUES ('jwt_secret', ?)").run(
      options.secret ?? SECRET,
    );
  }
  for (const username of options.users ?? []) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, 'real-hash');
  }
  return { path: dbPath, db };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} username
 * @returns {{ id: number, username: string, password_hash: string }}
 */
function userRow(db, username) {
  return /** @type {{ id: number, username: string, password_hash: string }} */ (
    db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username)
  );
}

/** @param {import('better-sqlite3').Database} db */
function userCount(db) {
  return /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
}

/**
 * The child env for a CLI run: everything the test process has, minus the server's secret, so a
 * developer shell that happens to export JWT_SECRET cannot make every case refuse.
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.JWT_SECRET;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
function runCli(argv, env) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    env: env ?? cliEnv(),
    encoding: 'utf8',
  });
}

/**
 * The lines `grep -rn <needle> <dir>` reports under ROOT, in `<path>:<line>:<text>` form. The same
 * command the task's AC uses, kept whole so a caller can look at WHICH file a hit came from.
 * @param {string} needle
 * @param {string[]} dirs
 * @returns {string[]}
 */
function grepLines(needle, dirs) {
  const result = spawnSync('grep', ['-rn', '--', needle, ...dirs], { cwd: ROOT, encoding: 'utf8' });
  if (result.status === 1) return [];
  assert.equal(result.status, 0, `grep failed: ${result.stderr}`);
  return String(result.stdout).split('\n').filter(Boolean);
}

/**
 * Counts `grep -rn <needle> <dir>` hits under ROOT.
 * @param {string} needle
 * @param {string[]} dirs
 * @returns {number}
 */
function grepCount(needle, dirs) {
  return grepLines(needle, dirs).length;
}

/**
 * Whether a `grep -rn` line names a TEST source rather than shipping code.
 *
 * WHAT INVARIANT 6 IS ABOUT is shipping code: a file the product runs must not reach back for the
 * operator tool. A test is not that — the tests under `server/modules/session-hosts/tests/` and
 * `server/modules/websocket/tests/` spawn `scripts/mint-token.mjs` precisely to exercise the CLI's
 * own refusal, and a test naming the tool it drives is the test doing its job, not the server taking
 * a dependency. The repository already draws this line the same way in
 * `scripts/asr-trim-capability-check.mjs`'s `isTestSource`.
 *
 * The scoping is what makes the invariant survive the tests that were added after it: the four hits
 * below all live under `tests/`, so an unscoped count reads a red about the test suite rather than
 * about the tool.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isTestSourceLine(line) {
  const file = line.slice(0, line.indexOf(':'));
  return /(^|\/)(tests|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/**
 * The `grep -rn` hits that name PRODUCTION sources — the count invariant 6 is stated over.
 * @param {string} needle
 * @param {string[]} dirs
 * @returns {number}
 */
function productionGrepCount(needle, dirs) {
  return grepLines(needle, dirs).filter((line) => !isTestSourceLine(line)).length;
}

// ---------------------------------------------------------------------------
// Invariant 1 — a fresh subject per mint; never an existing user id
// ---------------------------------------------------------------------------

test('invariant: a fresh subject is created for every mint — minting for an existing user id is refused', () => {
  const { db } = makeDb({ users: ['operator'] });
  const operator = userRow(db, 'operator');
  const before = userCount(db);

  assert.throws(
    () => mintObserverToken({ db, requestedUserId: operator.id }),
    /refusing to mint for user id/,
  );
  assert.equal(userCount(db), before, 'a refused mint must not leave a row behind');
  assert.equal(
    userRow(db, 'operator').password_hash,
    operator.password_hash,
    "the operator's row must be untouched by a refused mint",
  );

  // The pure guard is the same one the mint path calls, so it is falsifiable on its own.
  assert.doesNotThrow(() => assertFreshSubject(null));
  assert.doesNotThrow(() => assertFreshSubject(undefined));
  assert.throws(() => assertFreshSubject(operator.id), /must be signed for a subject this tool creates/);

  // Positive control for the invariant: a legitimate mint DOES create a new row.
  const minted = mintObserverToken({ db });
  assert.equal(userCount(db), before + 1);
  assert.notEqual(minted.id, operator.id, 'the new subject is a different row');
  assert.ok(minted.username.startsWith(OBSERVER_PREFIX), `username ${minted.username} carries the prefix`);

  // …and two mints are two subjects, never one reused row.
  const second = mintObserverToken({ db });
  assert.notEqual(second.id, minted.id);
  assert.equal(userCount(db), before + 2);
  assert.equal(decodeClaims(minted.token).userId, minted.id);
  assert.equal(decodeClaims(second.token).userId, second.id);
  db.close();
});

// ---------------------------------------------------------------------------
// Invariant 2 — the 30-minute TTL cap
// ---------------------------------------------------------------------------

test('invariant: TTL is capped at 30 minutes and a longer request is refused', () => {
  const { path: dbPath, db } = makeDb();

  assert.equal(MAX_TTL_MINUTES, 30);
  assert.doesNotThrow(() => assertTtlWithinCap(1));
  assert.doesNotThrow(() => assertTtlWithinCap(MAX_TTL_MINUTES));
  assert.throws(() => assertTtlWithinCap(MAX_TTL_MINUTES + 1), /the cap is hardcoded at 30 minutes/);
  assert.throws(() => assertTtlWithinCap(168 * 60), /hardcoded at 30 minutes/);
  assert.throws(() => assertTtlWithinCap(0), /positive integer/);
  assert.throws(() => assertTtlWithinCap(-5), /positive integer/);
  assert.throws(() => assertTtlWithinCap(1.5), /positive integer/);

  // The cap is a bound on the SIGNED token, not merely on the argument.
  const maxed = mintObserverToken({ db });
  assert.equal(maxed.ttlMinutes, MAX_TTL_MINUTES);
  assert.equal(Number(decodeClaims(maxed.token).exp) - Number(decodeClaims(maxed.token).iat), 1800);

  const short = mintObserverToken({ db, ttlMinutes: 5 });
  assert.equal(Number(decodeClaims(short.token).exp) - Number(decodeClaims(short.token).iat), 300);

  assert.throws(() => mintObserverToken({ db, ttlMinutes: 120 }), /hardcoded at 30 minutes/);

  // CLI face: the same refusal, and it must not leave a token file behind.
  const out = path.join(TMP, 'ttl-too-long.jwt');
  const result = runCli(['mint', '--db', dbPath, '--out', out, '--ttl-minutes', '120']);
  assert.equal(result.status, 1, `expected a refusal, got ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /hardcoded at 30 minutes/);
  assert.equal(fs.existsSync(out), false);
  db.close();
});

// ---------------------------------------------------------------------------
// Invariant 3 — the token goes to a 0600 file, never to stdout
// ---------------------------------------------------------------------------

test('invariant: the token never reaches stdout and the token file is mode 0600', () => {
  const { path: dbPath, db } = makeDb();
  const out = path.join(TMP, 'stdout-check.jwt');
  const result = runCli(['mint', '--db', dbPath, '--out', out]);

  assert.equal(result.status, 0, `mint failed: ${result.stderr}`);

  // Positive controls FIRST: without them the "no token on stdout" reading is vacuous — an
  // inert command prints no token either. The token must exist, and the run must have reported.
  const token = fs.readFileSync(out, 'utf8').trim();
  assert.ok(token.split('.').length === 3, `the file holds a JWT, got ${token.slice(0, 20)}`);
  assert.match(result.stdout, /^subject: observer-/m);
  assert.match(result.stdout, new RegExp(`user id ${decodeClaims(token).userId}`));

  // …and now the invariant itself.
  assert.equal(result.stdout.includes(token), false, 'the token must not appear on stdout');
  assert.equal(
    result.stdout.includes(token.split('.')[2]),
    false,
    'not even the signature segment may appear on stdout',
  );
  assert.equal((result.stdout + result.stderr).includes(SECRET), false, 'the signing secret must not leak');

  const mode = fs.statSync(out).mode & 0o777;
  assert.equal(mode, 0o600, `token file mode is ${mode.toString(8)}, expected 600`);

  // Re-minting over an existing, looser file must tighten it rather than inherit its bits.
  fs.chmodSync(out, 0o644);
  const again = runCli(['mint', '--db', dbPath, '--out', out]);
  assert.equal(again.status, 0, `second mint failed: ${again.stderr}`);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  db.close();
});

// ---------------------------------------------------------------------------
// Invariant 4 — refuse to run when JWT_SECRET is reachable
// ---------------------------------------------------------------------------

test('invariant: refuses to run when JWT_SECRET is reachable from the environment or .env', () => {
  const { path: dbPath } = makeDb();

  assert.doesNotThrow(() => assertNoServerSecret({ env: {} }));
  assert.throws(() => assertNoServerSecret({ env: { JWT_SECRET: 'x' } }), /JWT_SECRET is set in the environment/);
  assert.throws(
    () => assertNoServerSecret({ env: {}, envText: 'JWT_SECRET=abc\n' }),
    /present in \.env/,
  );
  assert.throws(
    () => assertNoServerSecret({ env: {}, envText: '# preamble\nexport JWT_SECRET="abc"\n' }),
    /present in \.env/,
  );
  // A mention that is not an assignment is not a secret.
  assert.doesNotThrow(() => assertNoServerSecret({ env: {}, envText: '# JWT_SECRET is optional\n' }));
  assert.doesNotThrow(() => assertNoServerSecret({ env: {}, envText: null }));

  // CLI face: the refusal happens BEFORE the database is touched, so no token file appears.
  const out = path.join(TMP, 'secret-present.jwt');
  const refused = runCli(['mint', '--db', dbPath, '--out', out], cliEnv({ JWT_SECRET: 'from-the-env' }));
  assert.equal(refused.status, 1, `expected a refusal, got ${refused.status}: ${refused.stdout}`);
  assert.match(refused.stderr, /JWT_SECRET is set in the environment/);
  assert.equal(fs.existsSync(out), false);

  // Positive control: the identical command without the secret succeeds.
  const allowed = runCli(['mint', '--db', dbPath, '--out', out]);
  assert.equal(allowed.status, 0, `the same command without JWT_SECRET must work: ${allowed.stderr}`);
  assert.equal(fs.existsSync(out), true);
});

// ---------------------------------------------------------------------------
// Invariant 5 — revoke proves its own effect, or reports failure
// ---------------------------------------------------------------------------

test('invariant: revoke verifies the row is gone AND the token is now 401, and reports failure otherwise', async () => {
  const { db } = makeDb();
  const subjectGone = (/** @type {number} */ id) =>
    db.prepare('SELECT id FROM users WHERE id = ?').get(id) === undefined;

  // A server that did NOT honour the deletion: row gone locally, token still answers 200.
  const unrenewed = mintObserverToken({ db });
  await assert.rejects(
    revokeObserverSubject({ db, token: unrenewed.token, verifyStatus: async () => 200 }),
    /the row is gone but the token still answers 200/,
  );
  assert.ok(subjectGone(unrenewed.id), 'the delete still happened — the failure is the verification');

  // A probe that never returned 401 (unreachable server) is a failure too, not a pass.
  const unreachable = mintObserverToken({ db });
  await assert.rejects(
    revokeObserverSubject({ db, token: unreachable.token, verifyStatus: async () => 0 }),
    /expected 401/,
  );
  assert.ok(subjectGone(unreachable.id));

  // The happy path: exact delete, row absent, 401 observed.
  const minted = mintObserverToken({ db });
  const result = await revokeObserverSubject({
    db,
    token: minted.token,
    verifyStatus: async (token) => (token === minted.token ? 401 : 0),
  });
  assert.deepEqual(result, { id: minted.id, username: minted.username, status: 401 });
  assert.ok(subjectGone(minted.id));

  // A second revoke of the same subject cannot claim success: nothing left to delete.
  await assert.rejects(
    revokeObserverSubject({ db, token: minted.token, verifyStatus: async () => 401 }),
    /expected to delete exactly one observer row \(id \d+\), deleted 0/,
  );

  // The operator's own row is never a revoke target, even holding a validly signed token for it.
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('operator', 'real-hash');
  const operator = userRow(db, 'operator');
  const operatorToken = signHs256(readJwtSecret(db), {
    userId: operator.id,
    username: 'operator',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  await assert.rejects(
    revokeObserverSubject({ db, token: operatorToken, verifyStatus: async () => 401 }),
    /is not an observer-\* row/,
  );
  assert.ok(userRow(db, 'operator'), "the operator's row must survive a revoke attempt");
  db.close();
});

// ---------------------------------------------------------------------------
// Invariant 6 — no server/ or src/ reference
// ---------------------------------------------------------------------------

test('invariant: no server/ or src/ PRODUCTION file references this tool', () => {
  // Positive control first: the same grep DOES find a string that is genuinely present in
  // server/, so a zero below is a reading about `mint-token`, not about a broken grep.
  assert.ok(
    grepCount('getOrCreateJwtSecret', ['server/', 'src/']) > 0,
    'the grep helper must be able to find a string that is present in server/',
  );

  // Second positive control, for the SCOPING rather than the grep: the raw search does see the tool
  // named in `server/`, in the tests that drive its CLI. Without this the exclusion of test sources
  // would be indistinguishable from a search that finds nothing — and a reader would have no way to
  // tell that the four hits are accounted for rather than silently dropped.
  const raw = grepLines('mint-token', ['server/', 'src/']);
  assert.ok(
    raw.length > 0,
    'the raw grep must see the tool named by the tests that spawn it, or this scoping is untested',
  );
  assert.ok(
    raw.every(isTestSourceLine),
    `every raw hit must be a test source; these are not:\n${raw.filter((line) => !isTestSourceLine(line)).join('\n')}`,
  );

  // …and the invariant itself: no production source reaches for the tool.
  assert.equal(productionGrepCount('mint-token', ['server/', 'src/']), 0);
  assert.equal(productionGrepCount('mintObserverToken', ['server/', 'src/']), 0);
});

// ---------------------------------------------------------------------------
// Supporting readings
// ---------------------------------------------------------------------------

test('a minted token verifies against the database secret and carries the fresh subject', () => {
  const { db } = makeDb();
  const minted = mintObserverToken({ db, now: Date.UTC(2026, 8, 22, 13, 15, 0) });
  const claims = decodeClaims(minted.token);
  assert.equal(claims.userId, minted.id);
  assert.equal(claims.username, minted.username);

  // Independently recompute the HS256 signature — the server's `jwt.verify(token, secret)` is
  // this comparison, so a token that does not reproduce here would 401 in production.
  const [header, payload, signature] = minted.token.split('.');
  const expected = createHmac('sha256', readJwtSecret(db)).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected);
  assert.equal(
    observerUsername(Date.UTC(2026, 8, 22, 13, 15, 0), 'abcdef'),
    `${OBSERVER_PREFIX}20260922T131500Z-abcdef`,
  );
  db.close();
});

test('a database whose server never booted is refused rather than silently provisioned', () => {
  const { db } = makeDb({ secret: null });
  assert.throws(() => readJwtSecret(db), /no app_config\.jwt_secret row/);
  assert.throws(() => mintObserverToken({ db }), /no app_config\.jwt_secret row/);
  assert.equal(userCount(db), 0, 'the refusal must happen before any row is written');
  db.close();
});

test('the observer subject cannot be logged into: its password_hash is not a bcrypt hash', () => {
  const { db } = makeDb();
  const minted = mintObserverToken({ db });
  const row = userRow(db, minted.username);
  assert.equal(row.password_hash.length, 64);
  assert.match(row.password_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.password_hash.startsWith('$2'), false, 'a bcrypt-shaped hash would be guessable-as-real');
  db.close();
});
