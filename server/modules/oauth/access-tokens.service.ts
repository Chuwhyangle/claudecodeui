/**
 * Personal access token service.
 *
 * Issues, verifies and revokes `ccp_` tokens. Plaintext is generated here and
 * returned exactly once; only its SHA-256 hash and an 8-character prefix reach
 * the database, so a leaked database cannot be replayed as a token. Every
 * timestamp comes from the injected clock, which is what makes expiry and
 * revocation testable without waiting on wall time. The `last_used` stamp a
 * successful verification writes is throttled through `lastUsedStamp`, so the
 * settings page's "last used" reads as fresh without a write per request.
 *
 * Consumers: this module's criteria, and the AC-227 settings routes.
 */

import crypto from 'crypto';

import { accessTokensDb } from '@/modules/database/index.js';
import { ACCESS_TOKEN_SCOPES } from '@/shared/mcp-contract/index.js';
import { lastUsedStamp } from '@/shared/utils.js';

/** Every token minted by this service carries this prefix, per mcp-gateway-SPEC. */
const TOKEN_PREFIX = 'ccp_';

/** Prefix length stored for display: `ccp_` plus five hex digits. */
const PREFIX_LENGTH = 8;

/** The only accepted lifetimes, in days. A token never outlives 90 days. */
const ALLOWED_EXPIRY_DAYS: readonly number[] = [7, 30, 90];

/** Lifetime applied when the caller omits `expiresInDays`. */
const DEFAULT_EXPIRY_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The complete vocabulary of scopes a personal access token may be issued with,
 * per mcp-gateway-SPEC. `cloudcli:admin` is deliberately absent: it is reserved
 * and cannot be minted. Consumers: {@link normalizeAccessTokenScopes}, this
 * module's `issueToken`, the settings module's `createAccessToken` and the MCP
 * tool authorisation checks — this is the single definition, never duplicated.
 *
 * The constant itself lives in the contract (`server/shared/mcp-contract`,
 * proposal `docs/proposals/mcp-gateway-tool-architecture.md` stage 1), because
 * the stage-2 tool packages must read the same vocabulary without importing
 * `server/modules/**`. It is re-exported here so this module's and the OAuth
 * barrel's public surface are unchanged.
 *
 * Positional reads predate some appends, so the order is load-bearing: read,
 * session:send, session:create, session:control, approve, navigate, selection.
 */
export { ACCESS_TOKEN_SCOPES };

/**
 * Why a verification failed. The five values are mutually distinct so a caller
 * can tell an expired token from a revoked one, a mistyped one, a foreign
 * prefix, and a scope escalation.
 */
export type AccessTokenRejectionReason =
  | 'invalid_prefix'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'insufficient_scope';

/** A freshly issued token. `token` is the plaintext and is never stored. */
export type IssuedAccessToken = {
  id: number;
  token: string;
  tokenPrefix: string;
  expiresAt: string;
};

/**
 * Result of issuing. `invalid_expiry` means the requested lifetime was not one
 * of 7/30/90 (or was a non-number such as `null` for a permanent token);
 * `invalid_scope` means the scope list was not a non-empty subset of
 * {@link ACCESS_TOKEN_SCOPES}. Neither failure writes a row.
 */
export type IssueAccessTokenResult =
  | { ok: true; token: IssuedAccessToken }
  | { ok: false; reason: 'invalid_expiry' | 'invalid_scope' };

/**
 * Result of verifying. On success the owner id, the token's scopes and its
 * expiry are returned; on failure exactly one of the
 * {@link AccessTokenRejectionReason} values is returned.
 *
 * `expiresAt` is the stored ISO instant, carried out of the same row the check
 * already read so a verifier can report the token's lifetime without a second
 * lookup — the token-info route is its consumer. `tokenId` is that same row's
 * id, so the MCP audit log can attribute a tool call to the token that made it
 * (`/mcp`'s middleware is its consumer) without a second query.
 */
export type VerifyAccessTokenResult =
  | { ok: true; userId: number; tokenId: number; scopes: string[]; expiresAt: string }
  | { ok: false; reason: AccessTokenRejectionReason };

/** Caller-supplied fields for {@link AccessTokensService.issueToken}. */
export type IssueAccessTokenInput = {
  userId: number;
  name?: string | null;
  scopes: string[];
  /** One of 7/30/90; omitted means 30. `null`, 0, negatives, 365 and Infinity are rejected. */
  expiresInDays?: number | null;
};

export type AccessTokensService = {
  issueToken(input: IssueAccessTokenInput): IssueAccessTokenResult;
  /**
   * Hashes `token` and looks it up. When `requiredScope` is given, a token that
   * does not grant it is rejected as `insufficient_scope`. A successful check
   * stamps `last_used` from the injected clock, throttled to at most one write
   * per `LAST_USED_STAMP_INTERVAL_MS` (see `lastUsedStamp`).
   */
  verifyToken(token: string, requiredScope?: string): VerifyAccessTokenResult;
  /** Stamps `revoked_at`; the next `verifyToken` rejects the token with no restart. */
  revokeToken(id: number): boolean;
};

/** Construction options; `now` is the only clock the service reads. */
export type AccessTokensServiceOptions = {
  now: () => Date;
};

/** SHA-256 of the plaintext token, lowercase hex — the only form written to disk. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** True when `days` is an integer in the allowed whitelist. */
function isAllowedExpiryDays(days: number | null | undefined): days is number {
  return typeof days === 'number' && Number.isInteger(days) && ALLOWED_EXPIRY_DAYS.includes(days);
}

/**
 * Validates a requested scope list against {@link ACCESS_TOKEN_SCOPES} and
 * removes duplicates, preserving first-occurrence order. This is the single
 * vocabulary check and deduplication used by both issuance paths, so no caller
 * can mint an unknown, reserved, empty or duplicated scope. Consumers: this
 * module's `issueToken` and the settings module's `createAccessToken`.
 *
 * Returns `{ ok: false }` for a non-array, an empty array, any non-string
 * element, or any string outside the vocabulary; otherwise `{ ok: true }` with
 * the deduplicated list.
 */
export function normalizeAccessTokenScopes(
  scopes: unknown,
): { ok: true; scopes: string[] } | { ok: false } {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false };
  }
  const vocabulary: readonly string[] = ACCESS_TOKEN_SCOPES;
  const normalized: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !vocabulary.includes(scope)) {
      return { ok: false };
    }
    if (!normalized.includes(scope)) {
      normalized.push(scope);
    }
  }
  return { ok: true, scopes: normalized };
}

/**
 * Builds the token service. `now` is called for `created_at`, `expires_at`,
 * `last_used` and `revoked_at`, and for the expiry comparison, so a test can
 * advance time by mutating what the clock returns.
 */
export function createAccessTokensService({ now }: AccessTokensServiceOptions): AccessTokensService {
  return {
    issueToken(input: IssueAccessTokenInput): IssueAccessTokenResult {
      // Vocabulary check first: an out-of-vocabulary scope is rejected at the
      // service boundary, so calling this directly (bypassing the route) can
      // never mint an unknown, reserved, empty or duplicated scope.
      const normalized = normalizeAccessTokenScopes(input.scopes);
      if (!normalized.ok) {
        return { ok: false, reason: 'invalid_scope' };
      }

      const days = input.expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : input.expiresInDays;
      if (!isAllowedExpiryDays(days)) {
        return { ok: false, reason: 'invalid_expiry' };
      }

      // 32 random bytes; the plaintext exists only in this return value.
      const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + days * MS_PER_DAY);

      const id = accessTokensDb.insert({
        userId: input.userId,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, PREFIX_LENGTH),
        name: input.name ?? null,
        scopes: JSON.stringify(normalized.scopes),
        expiresAt: expiresAt.toISOString(),
        createdAt: issuedAt.toISOString(),
      });

      return {
        ok: true,
        token: { id, token, tokenPrefix: token.slice(0, PREFIX_LENGTH), expiresAt: expiresAt.toISOString() },
      };
    },

    verifyToken(token: string, requiredScope?: string): VerifyAccessTokenResult {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
        return { ok: false, reason: 'invalid_prefix' };
      }

      const row = accessTokensDb.findByHash(hashToken(token));
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.revoked_at !== null) {
        return { ok: false, reason: 'revoked' };
      }
      if (now().getTime() >= new Date(row.expires_at).getTime()) {
        return { ok: false, reason: 'expired' };
      }

      const scopes = JSON.parse(row.scopes) as string[];
      if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
        return { ok: false, reason: 'insufficient_scope' };
      }

      // Throttle: a hot /mcp stream re-verifies the same token on every request,
      // so only write when the stored instant is missing or older than the
      // window. `lastUsedStamp` owns that comparison.
      const stamp = lastUsedStamp(row.last_used, now());
      if (stamp !== null) {
        accessTokensDb.updateLastUsed(row.id, stamp);
      }
      return { ok: true, userId: row.user_id, tokenId: row.id, scopes, expiresAt: row.expires_at };
    },

    revokeToken(id: number): boolean {
      return accessTokensDb.revoke(id, now().toISOString());
    },
  };
}
