#!/usr/bin/env node
// mint-token.mjs — short-TTL observation credential for an AI agent, on a ONE-TIME subject.
//
// WHY A ONE-TIME SUBJECT (and not a short token for the operator's own account)
// ---------------------------------------------------------------------------
// A short TTL alone buys nothing here: `authenticateToken` (server/modules/auth/auth.middleware.ts)
// re-issues a token whenever the presented one is past HALF its lifetime, and
// `POST /api/auth/refresh` hands out a fresh 7d one on demand. So any credential minted for a
// real user is renewable indefinitely by whoever holds it, and revoking it means rotating
// `jwt_secret` — which logs the operator out and needs a restart.
//
// What actually revokes instantly is the SUBJECT, not the token: `userDb.getUserById` filters
// `is_active = 1` and `authenticateToken` calls it on every request. So this tool mints a token
// for a `users` row it just created (`username = observer-<ts>-<rand>`). Revoking = DELETE that
// row: immediate, no restart, no secret rotation, no effect on the operator's own session.
// The 30-minute TTL is a second, independent bound, not the mechanism.
//
// INVARIANTS THIS TOOL ENFORCES BY ITSELF (no server-side code backstops them; each one is a
// named case in scripts/mint-token.test.mjs):
//   1. A FRESH subject is created on every mint. Minting for an existing user id is refused —
//      that is the one constraint the whole design rests on, because a token for a pre-existing
//      row cannot be revoked without touching the operator's account.
//   2. TTL is capped at 30 minutes, hardcoded; a longer request is refused rather than clamped.
//   3. The token never goes to stdout — only to a 0600 file. Same for `probe` response bodies.
//   4. Refuses to run when JWT_SECRET is reachable from the environment or `.env`: signing with
//      the DB's secret while the server verifies with a different one would mint a token that
//      cannot work, and reporting success for that is worse than failing.
//   5. `revoke` verifies its own effect — the row is gone AND the token now answers 401 — and
//      reports FAILURE otherwise, never success.
//   6. Nothing under server/ or src/ references this tool: it is an operator-side probe, not a
//      service dependency.
//
// Runs on bare `node` (no tsx): `tsx` is a devDependency, so a `npm install -g` production
// install would not have it. Same reason scripts/release/*.js are plain JS.
//
// Usage:
//   node scripts/mint-token.mjs mint   --db <auth.db> --out <token-file> [--ttl-minutes N]
//   node scripts/mint-token.mjs probe  --token-file <f> --base-url <url>
//                                      [--method GET|POST] [--path /api/auth/user] [--out <response-file>]
//   node scripts/mint-token.mjs revoke --db <auth.db> --token-file <f> --base-url <url>
//                                      [--path /api/auth/user]
//   node scripts/mint-token.mjs sweep  --db <auth.db> [--apply]
//
// Exit codes: 0 = the requested thing happened and was verified; 1 = refused or verification
// failed (the reason is on stderr); 2 = usage error.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hardcoded upper bound for the TTL, in minutes. Invariant 2. */
export const MAX_TTL_MINUTES = 30;

/** Prefix that marks a row as a revocable one-time subject. */
export const OBSERVER_PREFIX = 'observer-';

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Invariant 1. The mint path calls this with whatever user id the caller asked for; the CLI
 * never has a flag to supply one, so from the CLI this is always `null`. Keeping the parameter
 * (and the check) is what makes the constraint testable and impossible to drop silently.
 * @param {number|null|undefined} requestedUserId
 */
export function assertFreshSubject(requestedUserId) {
  if (requestedUserId === null || requestedUserId === undefined) return;
  throw new Error(
    `refusing to mint for user id ${String(requestedUserId)}: an observer token must be signed ` +
      `for a subject this tool creates, because revoking it is a DELETE of that new row. A token ` +
      `for a pre-existing row cannot be revoked without touching the operator's own account.`,
  );
}

/**
 * Invariant 2.
 * @param {number} minutes
 * @returns {number}
 */
export function assertTtlWithinCap(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`--ttl-minutes must be a positive integer, got ${String(minutes)}`);
  }
  if (minutes > MAX_TTL_MINUTES) {
    throw new Error(
      `refusing a ${minutes}-minute TTL: the cap is hardcoded at ${MAX_TTL_MINUTES} minutes ` +
        `(a longer window adds nothing — revocation is on the subject, not on the token — and it ` +
        `is the bound that makes a leaked file self-limiting).`,
    );
  }
  return minutes;
}

/**
 * Invariant 4. `env` and the repo-root `.env` are both checked: the server reads
 * `process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret()`, so either source means the
 * DB's stored secret is NOT what the running server verifies with.
 * @param {{ env?: Record<string, string|undefined>, envText?: string|null }} [sources]
 */
export function assertNoServerSecret(sources = {}) {
  const env = sources.env ?? process.env;
  if (env.JWT_SECRET) {
    throw new Error(
      'refusing to run: JWT_SECRET is set in the environment, so the server signs with that ' +
        'value and not with the secret stored in the database — a token minted here would not ' +
        'verify. Unset JWT_SECRET for the mint/revoke invocation (the server keeps its own).',
    );
  }
  const envText = sources.envText === undefined ? readDotEnvText() : sources.envText;
  if (envText && /^\s*(?:export\s+)?JWT_SECRET\s*=/m.test(envText)) {
    throw new Error(
      'refusing to run: a JWT_SECRET assignment is present in .env, which the server loads — ' +
        'same mismatch as an exported JWT_SECRET. Remove it (or point DATABASE_PATH at a copy ' +
        'with the matching secret) before minting.',
    );
  }
}

/** @returns {string|null} the repo-root `.env` text, or null when there is no such file. */
function readDotEnvText() {
  try {
    return fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token minting (HS256, node:crypto — no jsonwebtoken, which ships no type declarations)
// ---------------------------------------------------------------------------

/**
 * @param {string} secret
 * @param {Record<string, unknown>} claims
 * @returns {string}
 */
export function signHs256(secret, claims) {
  const b64 = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Reads the JWT signing secret the way the server does, but WITHOUT creating one: a run against
 * a database the server has never booted would otherwise invent a secret that the next boot
 * reads back — i.e. this tool would be silently provisioning a credential store.
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
export function readJwtSecret(db) {
  /** @type {{ value?: string }|undefined} */
  let row;
  try {
    row = /** @type {{ value?: string }|undefined} */ (
      db.prepare("SELECT value FROM app_config WHERE key = 'jwt_secret'").get()
    );
  } catch (error) {
    throw new Error(
      `could not read app_config.jwt_secret (${error instanceof Error ? error.message : String(error)}); ` +
        'point --db at the auth.db the running server uses.',
    );
  }
  if (!row?.value) {
    throw new Error(
      'this database has no app_config.jwt_secret row — boot the server once against it so the ' +
        'secret exists, then mint against that same file.',
    );
  }
  return row.value;
}

/**
 * Decodes a JWT payload WITHOUT verifying it. Used to learn which subject a token belongs to;
 * never used as an authorization decision (the server re-verifies on every request).
 * @param {string} token
 * @returns {Record<string, unknown>}
 */
export function decodeClaims(token) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) throw new Error('not a JWT: expected three dot-separated segments');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (typeof payload !== 'object' || payload === null) throw new Error('JWT payload is not an object');
  return payload;
}

/**
 * Creates the one-time subject and signs its token. Returns everything the caller needs and
 * NOTHING that has to be kept secret beyond `token` itself.
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   ttlMinutes?: number,
 *   requestedUserId?: number|null,
 *   now?: number,
 *   randomHex?: string,
 * }} options
 */
export function mintObserverToken(options) {
  const { db } = options;
  const ttlMinutes = assertTtlWithinCap(options.ttlMinutes ?? MAX_TTL_MINUTES);
  // Invariant 1 lives here, before any write: a refusal must not leave a row behind.
  assertFreshSubject(options.requestedUserId ?? null);

  const secret = readJwtSecret(db);
  const now = options.now ?? Date.now();

  /** @type {{ id: number, username: string }|null} */
  let subject = null;
  // The username suffix is random, so a collision is not expected — but "not expected" is not an
  // invariant, and retrying keeps a collision from being reported as a mint failure.
  for (let attempt = 0; attempt < 5 && subject === null; attempt += 1) {
    const username = observerUsername(now, options.randomHex ?? crypto.randomBytes(6).toString('hex'));
    try {
      const result = db
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, crypto.randomBytes(32).toString('hex'));
      subject = { id: Number(result.lastInsertRowid), username };
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
    }
  }
  if (subject === null) throw new Error('could not allocate a unique observer username');

  const iat = Math.floor(now / 1000);
  const exp = iat + ttlMinutes * 60;
  const token = signHs256(secret, {
    userId: subject.id,
    username: subject.username,
    iat,
    exp,
  });
  return { id: subject.id, username: subject.username, token, iat, exp, ttlMinutes };
}

/**
 * @param {number} nowMs
 * @param {string} randomHex
 * @returns {string}
 */
export function observerUsername(nowMs, randomHex) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${OBSERVER_PREFIX}${stamp}-${randomHex}`;
}

// ---------------------------------------------------------------------------
// Probe / revoke
// ---------------------------------------------------------------------------

/**
 * One authenticated request. Only the status code is returned by default; a caller that needs a
 * response body (the refresh flow) asks for it explicitly, because a body can contain a token.
 * @param {{ baseUrl: string, path?: string, method?: string, token: string,
 *           fetchImpl?: typeof fetch, saveTo?: string|null }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function probeToken(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(options.path ?? '/api/auth/user', options.baseUrl).toString();
  const response = await fetchImpl(url, {
    method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${options.token}` },
  });
  const body = await response.text();
  if (options.saveTo) writeSecretFile(options.saveTo, body);
  return { status: response.status, body };
}

/**
 * Invariant 5: delete the subject, then PROVE it took effect. A `revoke` that reports success
 * without the 401 reading is the failure mode this whole tool exists to avoid — it would leave
 * the operator believing a credential is dead while it still answers.
 * @param {{ db: import('better-sqlite3').Database, token: string,
 *           verifyStatus?: (token: string) => Promise<number> }} options
 */
export async function revokeObserverSubject(options) {
  const { db, token } = options;
  const claims = decodeClaims(token);
  const username = String(claims.username ?? '');
  const userId = Number(claims.userId);
  if (!username.startsWith(OBSERVER_PREFIX)) {
    throw new Error(
      `refusing to revoke: the token's subject '${username}' is not an ${OBSERVER_PREFIX}* row. ` +
        'This tool only ever deletes subjects it created.',
    );
  }
  if (!Number.isInteger(userId)) throw new Error('refusing to revoke: the token carries no numeric userId');

  const deleted = db.prepare('DELETE FROM users WHERE id = ? AND username = ?').run(userId, username);
  if (deleted.changes !== 1) {
    throw new Error(
      `refusing to report success: expected to delete exactly one observer row (id ${userId}), ` +
        `deleted ${deleted.changes}.`,
    );
  }
  const stillThere = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (stillThere) throw new Error(`refusing to report success: user id ${userId} is still present`);

  const verify = options.verifyStatus ?? (async () => 0);
  const status = await verify(token);
  if (status !== 401) {
    throw new Error(
      `refusing to report success: the row is gone but the token still answers ${status} ` +
        '(expected 401). The subject deletion did not take effect for the running server.',
    );
  }
  return { id: userId, username, status };
}

// ---------------------------------------------------------------------------
// Sweep — clear one-time subjects left behind by a mint that was never revoked
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: number, username: string, createdAt: string|null, pastTtl: boolean }} ObserverSubject
 */

/**
 * The `users` rows whose username carries OBSERVER_PREFIX — the only rows `sweep` will ever touch.
 *
 * The prefix test is `String.prototype.startsWith`, NOT SQL `LIKE 'observer-%'`: SQLite's LIKE is
 * case-INsensitive for ASCII, so it would also match `Observer-…`, and this tool's safety rests on
 * matching its own prefix and nothing else. `startsWith` is the same predicate `revokeObserverSubject`
 * uses, so the two deletion paths agree on what an observer subject is.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} nowMs
 * @returns {ObserverSubject[]}
 */
export function listObserverSubjects(db, nowMs) {
  const rows = /** @type {{ id: number, username: string, created_at: string|null }[]} */ (
    db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all()
  );
  return rows
    .filter((row) => row.username.startsWith(OBSERVER_PREFIX))
    .map((row) => {
      const createdAtMs = parseSqliteUtc(row.created_at);
      return {
        id: row.id,
        username: row.username,
        createdAt: row.created_at,
        // Informational only: the TTL bounds the TOKEN, and the row is swept whether or not that
        // token is still live (a leftover row is a leftover row). An absent/unparseable created_at
        // is reported as "not known expired" rather than guessed from nothing.
        pastTtl: createdAtMs !== null && nowMs - createdAtMs > MAX_TTL_MINUTES * 60 * 1000,
      };
    });
}

/**
 * SQLite's `CURRENT_TIMESTAMP` (the schema's DEFAULT for `users.created_at`) writes `YYYY-MM-DD
 * HH:MM:SS` in UTC. Returns epoch ms, or null when the value is absent/blank/unparseable.
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function parseSqliteUtc(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Lists the leftover observer subjects and, with `apply`, deletes them — verifying its own effect
 * the way `revoke` does (read the rows back; refuse to report success if one survives).
 *
 * WHY A SWEEP IS NEEDED WHEN `revoke` EXISTS: `revoke` needs the token, but the token lives in a
 * 0600 file an operator routinely deletes once the probe is done. The leftover `users` row is
 * itself the credential — `authenticateToken` re-checks `is_active` for it on every request — and it
 * is exactly what a mint leaves behind. So a residue with no token left to identify it still has to
 * be clearable, and the row's own `observer-` prefix is the identity it is cleared by.
 *
 * Dry run is the DEFAULT: with no `apply`, nothing is deleted and the return is the listing.
 *
 * @param {{ db: import('better-sqlite3').Database, apply?: boolean, now?: number }} options
 * @returns {{ applied: boolean, deleted: number, subjects: ObserverSubject[] }}
 */
export function sweepObserverSubjects(options) {
  const { db } = options;
  const apply = options.apply ?? false;
  const now = options.now ?? Date.now();
  const subjects = listObserverSubjects(db, now);

  if (!apply) return { applied: false, deleted: 0, subjects };

  const deleteRow = db.prepare('DELETE FROM users WHERE id = ? AND username = ?');
  let deleted = 0;
  for (const subject of subjects) deleted += deleteRow.run(subject.id, subject.username).changes;

  // Self-verification, the same shape as revoke's invariant 5: the rows must actually be gone AND
  // the count must match what was listed. A DELETE that quietly did nothing must not read as success.
  const remaining = listObserverSubjects(db, now);
  if (remaining.length !== 0) {
    throw new Error(
      `refusing to report success: ${remaining.length} observer subject(s) still present after the sweep`,
    );
  }
  if (deleted !== subjects.length) {
    throw new Error(
      `refusing to report success: listed ${subjects.length} observer subject(s) but deleted ${deleted}`,
    );
  }
  return { applied: true, deleted, subjects };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath
 * @param {string} contents
 */
function writeSecretFile(filePath, contents) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  // writeFileSync's mode only applies at creation; an existing file keeps its old bits.
  fs.chmodSync(filePath, 0o600);
}

/**
 * Flags that take no value. A bare `--apply` is a flag, not a missing argument, so it must be told
 * apart from the value-taking flags (`--db`, `--out`, …) before the "needs a value" branch below.
 */
const BOOLEAN_FLAGS = new Set(['apply']);

/**
 * @param {string[]} argv
 * @returns {{ _: string[], [key: string]: unknown }}
 */
function parseArgs(argv) {
  /** @type {{ _: string[], [key: string]: unknown }} */
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf('=');
    const key = (eq >= 0 ? item.slice(2, eq) : item.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) {
      const value = item.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(key)) {
        // `--apply=true` is accepted; `--apply=no` is a usage error rather than a silent dry run.
        if (value !== 'true') throw new UsageError(`--${key} takes no value`);
        args[key] = true;
      } else {
        args[key] = value;
      }
    } else if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${item.slice(2)} needs a value`);
      }
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * @param {{ [key: string]: unknown }} args
 * @param {string} name
 * @returns {string}
 */
function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new UsageError(`--${name} is required`);
  return value;
}

/** @param {string} dbPath */
function openDb(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new UsageError(`--db not found: ${resolved}`);
  return new Database(resolved);
}

/** @returns {string} */
function usage() {
  return [
    'usage:',
    '  node scripts/mint-token.mjs mint   --db <auth.db> --out <token-file> [--ttl-minutes N]',
    '  node scripts/mint-token.mjs probe  --token-file <f> --base-url <url>',
    '                                     [--method GET|POST] [--path /api/auth/user] [--out <file>]',
    '  node scripts/mint-token.mjs revoke --db <auth.db> --token-file <f> --base-url <url>',
    '                                     [--path /api/auth/user]',
    '  node scripts/mint-token.mjs sweep  --db <auth.db> [--apply]',
    '                                     (list leftover observer-* subjects; --apply deletes them)',
  ].join('\n');
}

async function cmdMint(/** @type {{ [key: string]: unknown }} */ args) {
  const dbPath = requireArg(args, 'db');
  const out = requireArg(args, 'out');
  assertNoServerSecret();
  const db = openDb(dbPath);
  try {
    const ttlMinutes = args.ttlMinutes === undefined ? MAX_TTL_MINUTES : Number(args.ttlMinutes);
    const minted = mintObserverToken({ db, ttlMinutes });
    writeSecretFile(out, `${minted.token}\n`);
    // The token itself is deliberately absent from everything printed below.
    process.stdout.write(`subject: ${minted.username} (user id ${minted.id})\n`);
    process.stdout.write(`token file: ${path.resolve(out)} (mode 0600)\n`);
    process.stdout.write(`expires: ${new Date(minted.exp * 1000).toISOString()} (ttl ${minted.ttlMinutes}m)\n`);
    process.stdout.write(
      `this subject is one-time: run \`revoke\` to delete row ${minted.id}; nothing else references it\n`,
    );
  } finally {
    db.close();
  }
  return EXIT_OK;
}

async function cmdProbe(/** @type {{ [key: string]: unknown }} */ args) {
  const tokenFile = requireArg(args, 'tokenFile');
  const baseUrl = requireArg(args, 'baseUrl');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
  const target = typeof args.path === 'string' ? args.path : '/api/auth/user';
  const saveTo = typeof args.out === 'string' ? args.out : null;
  const result = await probeToken({ baseUrl, path: target, method, token, saveTo });
  process.stdout.write(`${method} ${target} -> ${result.status}\n`);
  if (saveTo) process.stdout.write(`response body: ${path.resolve(saveTo)} (mode 0600)\n`);
  return result.status === 200 ? EXIT_OK : EXIT_REFUSED;
}

async function cmdRevoke(/** @type {{ [key: string]: unknown }} */ args) {
  const dbPath = requireArg(args, 'db');
  const tokenFile = requireArg(args, 'tokenFile');
  const baseUrl = requireArg(args, 'baseUrl');
  const target = typeof args.path === 'string' ? args.path : '/api/auth/user';
  assertNoServerSecret();
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const db = openDb(dbPath);
  try {
    const result = await revokeObserverSubject({
      db,
      token,
      verifyStatus: async (value) => (await probeToken({ baseUrl, path: target, token: value })).status,
    });
    process.stdout.write(`deleted subject: ${result.username} (user id ${result.id})\n`);
    process.stdout.write(`verified: row absent; GET ${target} -> ${result.status}\n`);
  } finally {
    db.close();
  }
  return EXIT_OK;
}

async function cmdSweep(/** @type {{ [key: string]: unknown }} */ args) {
  const dbPath = requireArg(args, 'db');
  const apply = args.apply === true;
  // No assertNoServerSecret here: sweep signs nothing and reads no jwt_secret, it only enumerates and
  // (with --apply) deletes observer-* rows. The secret-mismatch refusal is about MINTING a token.
  const db = openDb(dbPath);
  try {
    const result = sweepObserverSubjects({ db, apply });
    process.stdout.write(
      `${apply ? 'sweep --apply' : 'sweep (dry run)'}: ${result.subjects.length} observer subject(s) in ` +
        `${path.resolve(dbPath)}\n`,
    );
    // Only id / username / created_at / TTL: never a token, hash, or provider material.
    for (const subject of result.subjects) {
      process.stdout.write(
        `  id=${subject.id} username=${subject.username} ` +
          `created_at=${subject.createdAt ?? 'null'} ttl=${subject.pastTtl ? 'expired' : 'within-ttl'}\n`,
      );
    }
    if (!apply) {
      process.stdout.write('nothing deleted (dry run); re-run with --apply to delete\n');
    } else {
      process.stdout.write(`deleted ${result.deleted} observer subject row(s)\n`);
      process.stdout.write('verified: no observer-* row remains\n');
    }
  } finally {
    db.close();
  }
  return EXIT_OK;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command === '--version') {
    process.stdout.write('mint-token 1\n');
    return EXIT_OK;
  }
  const args = parseArgs(argv.slice(1));
  switch (command) {
    case 'mint':
      return cmdMint(args);
    case 'probe':
      return cmdProbe(args);
    case 'revoke':
      return cmdRevoke(args);
    case 'sweep':
      return cmdSweep(args);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/* istanbul ignore next — the CLI boundary; the exported functions above carry the invariants. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        process.stderr.write(`mint-token: ${error.message}\n${usage()}\n`);
        process.exitCode = EXIT_USAGE;
        return;
      }
      process.stderr.write(`mint-token: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_REFUSED;
    });
}
