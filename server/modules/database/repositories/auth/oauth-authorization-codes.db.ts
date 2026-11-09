/**
 * OAuth authorization-code repository.
 *
 * Persists the PKCE authorization codes issued during the authorization-code
 * flow. Only the SHA-256 hash of the code is stored, so the plaintext exists
 * solely in the redirect back to the client. `scopes` is a JSON array string and
 * `code_challenge` the S256 challenge the code was issued against.
 *
 * This is the storage primitive; the single-use / 60-second admission rules
 * over these rows belong to AC-259. Consumers:
 * server/modules/oauth/oauth-store.service.ts, through the database module
 * barrel.
 */

import { getConnection } from '@/modules/database/core/index.js';

/** A persisted authorization-code row exactly as stored; `scopes` is a JSON array string. */
export type OAuthAuthorizationCodeRow = {
  code_hash: string;
  client_id: string;
  user_id: number;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string;
  expires_at: string;
};

/** The fields a caller supplies to insert a code row; `scopes` is pre-serialized. */
export type InsertOAuthAuthorizationCodeInput = {
  codeHash: string;
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
  scopes: string;
  resource: string;
  expiresAt: string;
};

const CODE_COLUMNS =
  'code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at';

export const oauthAuthorizationCodesDb = {
  /** Inserts an authorization-code row keyed by its hash. */
  insert(input: InsertOAuthAuthorizationCodeInput): void {
    getConnection()
      .prepare(
        `INSERT INTO oauth_authorization_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.codeHash,
        input.clientId,
        input.userId,
        input.redirectUri,
        input.codeChallenge,
        input.scopes,
        input.resource,
        input.expiresAt
      );
  },

  /** Finds a code by its SHA-256 hash; undefined when no row matches. */
  findByHash(codeHash: string): OAuthAuthorizationCodeRow | undefined {
    return getConnection()
      .prepare(`SELECT ${CODE_COLUMNS} FROM oauth_authorization_codes WHERE code_hash = ?`)
      .get(codeHash) as OAuthAuthorizationCodeRow | undefined;
  },

  /** Deletes a code by its hash — the primitive behind single-use consumption. Returns true when a row was removed. */
  deleteByHash(codeHash: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM oauth_authorization_codes WHERE code_hash = ?')
      .run(codeHash);
    return result.changes > 0;
  },
};
