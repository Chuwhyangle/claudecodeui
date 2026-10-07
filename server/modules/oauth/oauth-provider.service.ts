/**
 * OAuth authorization-server semantics (mcp-gateway-SPEC stage 5, AC-259).
 *
 * The store (`oauth-store.service.ts`) owns persistence and the revocation
 * cascades; this service owns the RULES layered on top of it: PKCE is mandatory
 * and must be S256, an authorization code is single-use and expires 60 seconds
 * after issue, a replayed code revokes the authorization it already issued,
 * refresh tokens rotate on every use and a replayed refresh revokes the whole
 * grant, both `redirect_uri` and `resource` are matched character-for-character,
 * a confidential client's secret is checked in constant time, and the token
 * lifetimes are configurable. Every timestamp comes from the injected clock, so
 * expiry and rotation are exercisable without sleeping.
 *
 * The 60-second authorization-code lifetime is a SPEC constant owned by the
 * store's `issueAuthorizationCode`; this service reads it back from the code
 * row's `expires_at` instead of accepting its own TTL option, so the two layers
 * cannot disagree about it.
 *
 * The audience check here is the decision `/mcp` consumes (AC-263 wires it into
 * the gateway's `authorize` seam). HTTP endpoints, the consent page, DCR, the
 * settings surface and the scope vocabulary are out of scope.
 *
 * `verifyAccessToken` also maintains the "last used" reading the settings page
 * shows for connected apps: an accepted OAuth access token stamps its own row
 * and its grant through `lastUsedStamp`, so the column is fresh without a write
 * on every `/mcp` request.
 *
 * Consumers: this module's `tests/oauth-provider.test.ts`; the later OAuth
 * endpoint tasks (AC-262+) build the authorization-server HTTP surface on it
 * through the OAuth module barrel.
 */

import crypto from 'crypto';

import {
  accessTokensDb,
  getConnection,
  oauthAuthorizationCodesDb,
  oauthClientsDb,
  oauthCodeRedemptionsDb,
  oauthGrantsDb,
} from '@/modules/database/index.js';
import type { OAuthStore, OAuthTokenRejectionReason } from '@/modules/oauth/oauth-store.service.js';
import { lastUsedStamp } from '@/shared/utils.js';

/** Stable error codes, shared by `authorize` and both token exchanges. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unauthorized_client';

/** Why an access-token verification failed: the store's reasons plus the audience mismatch. */
export type VerifyAccessTokenReason = OAuthTokenRejectionReason | 'invalid_target';

/** Construction options. `now` is the only clock the service reads; `store` is built by the caller with the same clock. */
export type OAuthProviderOptions = {
  store: OAuthStore;
  now?: () => Date;
  /** Origin the default RFC 8707 audience is derived from: `${publicBaseUrl}/mcp`. */
  publicBaseUrl: string;
  /** Access-token lifetime; defaults to `MCP_ACCESS_TOKEN_TTL_SEC` or 3600. */
  accessTokenTtlSeconds?: number;
  /** Refresh-token lifetime; defaults to `MCP_REFRESH_TOKEN_TTL_DAYS` or 30. */
  refreshTokenTtlDays?: number;
};

/** Caller-supplied fields for {@link OAuthProvider.authorize}. */
export type AuthorizeInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scopes: string[];
  resource?: string;
  userId: number;
};

/** Outcome of {@link OAuthProvider.authorize}. */
export type AuthorizeResult =
  | { ok: true; code: string; grantId: number }
  | { ok: false; error: OAuthErrorCode };

/** Caller-supplied fields for {@link OAuthProvider.exchangeAuthorizationCode}. */
export type ExchangeAuthorizationCodeInput = {
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
};

/** Caller-supplied fields for {@link OAuthProvider.exchangeRefreshToken}. */
export type ExchangeRefreshTokenInput = {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  /** Optional narrowing of the granted scopes; omitted inherits the refresh row's scopes. */
  scopes?: string[];
  resource?: string;
};

/** A freshly issued token pair, with the access token's lifetime in seconds. */
export type OAuthTokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

/** Outcome of either token exchange. */
export type ExchangeResult = ({ ok: true } & OAuthTokenPair) | { ok: false; error: OAuthErrorCode };

/**
 * Outcome of {@link OAuthProvider.verifyAccessToken}. On success it names the
 * token ROW (`tokenId`), the OAuth client the authorizing grant belongs to
 * (`clientId`), the owning user, the granted scopes, the grant id and the stored
 * expiry — the identity `/mcp`'s middleware folds into `McpPrincipal` so its
 * audit rows can tell an OAuth call from a personal-access-token one (AC-263).
 */
export type VerifyOAuthAccessTokenResult =
  | {
      ok: true;
      userId: number;
      tokenId: number;
      clientId: string | null;
      scopes: string[];
      grantId: number | null;
      expiresAt: string;
    }
  | { ok: false; reason: VerifyAccessTokenReason };

export type OAuthProvider = {
  /**
   * Validates an authorization request and, on success, records a consent grant,
   * issues a PKCE authorization code and writes the code→grant ledger row.
   */
  authorize(input: AuthorizeInput): AuthorizeResult;
  /** Redeems a code once, enforcing expiry, redirect, client secret, PKCE and audience, and issuing a token pair. */
  exchangeAuthorizationCode(input: ExchangeAuthorizationCodeInput): ExchangeResult;
  /** Rotates a refresh token, revoking the presented one and cascading on a replayed token. */
  exchangeRefreshToken(input: ExchangeRefreshTokenInput): ExchangeResult;
  /**
   * The lifetime, in seconds, this provider stamps on every access token it
   * issues (`expires_in`). Exposed so the consent screen can state the real
   * value from the provider constant instead of a hardcoded copy of it.
   */
  accessTokenTtlSeconds: number;
  /**
   * Verifies an access token and binds it to an audience. A successful check
   * stamps the token row's `last_used` and, when the token belongs to a grant,
   * the grant's, both throttled to one write per throttle window.
   */
  verifyAccessToken(token: string, options?: { resource?: string }): VerifyOAuthAccessTokenResult;
};

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const MILLIS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;

/** SHA-256 of `value`, lowercase hex. Mirrors the store's private hashing so a code hashes identically on both sides. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** S256 PKCE challenge: base64url of the SHA-256 of the verifier. */
function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time comparison of a plaintext secret against a stored SHA-256 hex hash. */
function secretMatchesHash(plaintext: string, expectedHashHex: string): boolean {
  const actual = Buffer.from(sha256Hex(plaintext), 'utf8');
  const expected = Buffer.from(expectedHashHex, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Whether every member of `requested` appears in `allowed` (narrowing only). */
function isSubset(requested: string[], allowed: string[]): boolean {
  return requested.every((scope) => allowed.includes(scope));
}

/**
 * Builds the provider over an existing store. `now` must be the same clock the
 * store was built with, so a TTL computed here and an expiry compared there
 * agree under test.
 */
export function createOAuthProvider(options: OAuthProviderOptions): OAuthProvider {
  const now = options.now ?? (() => new Date());
  const defaultAudience = `${options.publicBaseUrl}/mcp`;
  const accessTokenTtlSeconds =
    options.accessTokenTtlSeconds ??
    Number(process.env.MCP_ACCESS_TOKEN_TTL_SEC ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
  const refreshTokenTtlDays =
    options.refreshTokenTtlDays ??
    Number(process.env.MCP_REFRESH_TOKEN_TTL_DAYS ?? DEFAULT_REFRESH_TOKEN_TTL_DAYS);

  /** Issues a fresh access + refresh pair under `grantId`, both carrying `resource`. */
  function issueTokenPair(grantId: number, scopes: string[], resource: string): OAuthTokenPair {
    const issuedAt = now();
    const accessToken = options.store.issueOAuthToken({
      grantId,
      kind: 'oauth_access',
      scopes,
      resource,
      expiresAt: new Date(
        issuedAt.getTime() + accessTokenTtlSeconds * MILLIS_PER_SECOND
      ).toISOString(),
    }).token;
    const refreshToken = options.store.issueOAuthToken({
      grantId,
      kind: 'oauth_refresh',
      scopes,
      resource,
      expiresAt: new Date(
        issuedAt.getTime() + refreshTokenTtlDays * SECONDS_PER_DAY * MILLIS_PER_SECOND
      ).toISOString(),
    }).token;

    return { accessToken, refreshToken, expiresIn: accessTokenTtlSeconds };
  }

  return {
    accessTokenTtlSeconds,
    authorize({
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scopes,
      resource,
      userId,
    }: AuthorizeInput): AuthorizeResult {
      const client = oauthClientsDb.findById(clientId);
      if (!client || client.disabled_at !== null) {
        return { ok: false, error: 'unauthorized_client' };
      }

      // PKCE is mandatory and only S256 is accepted: a missing/empty challenge or
      // any method other than the literal 'S256' is refused before anything is issued.
      if (
        codeChallengeMethod !== 'S256' ||
        typeof codeChallenge !== 'string' ||
        codeChallenge.length === 0
      ) {
        return { ok: false, error: 'invalid_request' };
      }

      const registeredRedirectUris = JSON.parse(client.redirect_uris) as string[];
      if (!registeredRedirectUris.includes(redirectUri)) {
        return { ok: false, error: 'invalid_request' };
      }

      // The audience is bound to the gateway's own resource; anything else is refused.
      const audience = resource ?? defaultAudience;
      if (audience !== defaultAudience) {
        return { ok: false, error: 'invalid_target' };
      }

      const { grantId } = options.store.createGrant({ userId, clientId, scopes, resource: audience });
      const { code } = options.store.issueAuthorizationCode({
        clientId,
        userId,
        redirectUri,
        codeChallenge,
        scopes,
        resource: audience,
      });
      // The ledger row is what survives the code's deletion, so a replay can still
      // find (and revoke) the authorization this code gave rise to.
      oauthCodeRedemptionsDb.insert({ codeHash: sha256Hex(code), grantId });

      return { ok: true, code, grantId };
    },

    exchangeAuthorizationCode({
      code,
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier,
      resource,
    }: ExchangeAuthorizationCodeInput): ExchangeResult {
      return getConnection().transaction((): ExchangeResult => {
        const codeHash = sha256Hex(code);
        const codeRow = oauthAuthorizationCodesDb.findByHash(codeHash);

        if (!codeRow) {
          // No live code. If the ledger remembers this hash as redeemed, the code
          // is being replayed: revoke the whole authorization it already issued.
          const ledger = oauthCodeRedemptionsDb.findByHash(codeHash);
          if (ledger && ledger.redeemed_at !== null) {
            options.store.revokeGrant(ledger.grant_id);
          }
          return { ok: false, error: 'invalid_grant' };
        }

        if (codeRow.client_id !== clientId) {
          return { ok: false, error: 'invalid_grant' };
        }

        if (now().getTime() >= new Date(codeRow.expires_at).getTime()) {
          oauthAuthorizationCodesDb.deleteByHash(codeHash);
          return { ok: false, error: 'invalid_grant' };
        }

        if (redirectUri !== codeRow.redirect_uri) {
          return { ok: false, error: 'invalid_request' };
        }

        const client = oauthClientsDb.findById(clientId);
        if (!client) {
          return { ok: false, error: 'invalid_client' };
        }
        if (
          client.client_secret_hash !== null &&
          (typeof clientSecret !== 'string' ||
            !secretMatchesHash(clientSecret, client.client_secret_hash))
        ) {
          return { ok: false, error: 'invalid_client' };
        }

        if (pkceChallenge(codeVerifier) !== codeRow.code_challenge) {
          return { ok: false, error: 'invalid_grant' };
        }

        if (resource !== undefined && resource !== codeRow.resource) {
          return { ok: false, error: 'invalid_target' };
        }

        const ledger = oauthCodeRedemptionsDb.findByHash(codeHash);
        if (!ledger) {
          return { ok: false, error: 'invalid_grant' };
        }

        // Consume and issue atomically: the code row goes, the ledger is stamped
        // and the token pair is minted in one transaction.
        const scopes = JSON.parse(codeRow.scopes) as string[];
        oauthAuthorizationCodesDb.deleteByHash(codeHash);
        oauthCodeRedemptionsDb.markRedeemed(codeHash, now().toISOString());
        return { ok: true, ...issueTokenPair(ledger.grant_id, scopes, codeRow.resource) };
      })();
    },

    exchangeRefreshToken({
      refreshToken,
      clientId,
      clientSecret,
      scopes,
      resource,
    }: ExchangeRefreshTokenInput): ExchangeResult {
      return getConnection().transaction((): ExchangeResult => {
        const row = accessTokensDb.findByHash(sha256Hex(refreshToken));
        if (!row || row.kind !== 'oauth_refresh' || row.grant_id === null) {
          return { ok: false, error: 'invalid_grant' };
        }

        if (row.revoked_at !== null) {
          // A revoked refresh row means this token was already rotated (or the
          // grant was killed): replaying it revokes the entire authorization.
          options.store.revokeGrant(row.grant_id);
          return { ok: false, error: 'invalid_grant' };
        }

        const verified = options.store.verifyOAuthToken(refreshToken, 'oauth_refresh');
        if (!verified.ok) {
          return { ok: false, error: 'invalid_grant' };
        }

        const grant = oauthGrantsDb.findById(row.grant_id);
        if (!grant || grant.client_id !== clientId) {
          return { ok: false, error: 'invalid_grant' };
        }

        const client = oauthClientsDb.findById(clientId);
        if (!client) {
          return { ok: false, error: 'invalid_client' };
        }
        if (
          client.client_secret_hash !== null &&
          (typeof clientSecret !== 'string' ||
            !secretMatchesHash(clientSecret, client.client_secret_hash))
        ) {
          return { ok: false, error: 'invalid_client' };
        }

        const grantScopes = JSON.parse(grant.scopes) as string[];
        let resultScopes: string[];
        if (scopes === undefined) {
          resultScopes = verified.scopes;
        } else {
          // Narrowing is allowed; asking for anything outside the grant is not.
          if (!isSubset(scopes, grantScopes)) {
            return { ok: false, error: 'invalid_scope' };
          }
          resultScopes = scopes;
        }

        if (resource !== undefined && resource !== grant.resource) {
          return { ok: false, error: 'invalid_target' };
        }

        // Rotate: kill the presented refresh token, then mint the replacement pair.
        accessTokensDb.revoke(verified.tokenId, now().toISOString());
        return { ok: true, ...issueTokenPair(row.grant_id, resultScopes, grant.resource) };
      })();
    },

    verifyAccessToken(token: string, verifyOptions: { resource?: string } = {}): VerifyOAuthAccessTokenResult {
      const verified = options.store.verifyOAuthToken(token, 'oauth_access');
      if (!verified.ok) {
        return { ok: false, reason: verified.reason };
      }

      const row = accessTokensDb.findByHash(sha256Hex(token));
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }

      const expectedAudience = verifyOptions.resource ?? defaultAudience;
      if (row.resource !== expectedAudience) {
        return { ok: false, reason: 'invalid_target' };
      }

      // The grant names the OAuth client this token was issued to; a token whose
      // grant row is gone (it cannot be, the FK cascades) reads as null. `/mcp`'s
      // middleware copies this into the principal so the audit row distinguishes an
      // OAuth call from a PAT one (AC-263).
      const grant = row.grant_id === null ? null : oauthGrantsDb.findById(row.grant_id);

      // A successful verification is a "use": stamp the token row and, when it
      // belongs to a grant, the grant too, so the settings page's connected-apps
      // row stops reading as never-used. Both writes go through `lastUsedStamp`,
      // so a hot `/mcp` stream writes at most once per throttle window instead of
      // once per request.
      const stampAt = now();
      const tokenStamp = lastUsedStamp(row.last_used, stampAt);
      if (tokenStamp !== null) {
        accessTokensDb.updateLastUsed(row.id, tokenStamp);
      }
      if (grant) {
        const grantStamp = lastUsedStamp(grant.last_used, stampAt);
        if (grantStamp !== null) {
          oauthGrantsDb.updateLastUsed(grant.id, grantStamp);
        }
      }

      return {
        ok: true,
        userId: row.user_id,
        tokenId: row.id,
        clientId: grant?.client_id ?? null,
        scopes: verified.scopes,
        grantId: verified.grantId,
        expiresAt: verified.expiresAt,
      };
    },
  };
}
