/**
 * Access-token repository.
 *
 * Persists the rows behind the OAuth module's personal access tokens and OAuth
 * access/refresh tokens. The module never stores plaintext: callers pass the
 * SHA-256 hash and the display prefix. Every timestamp is passed in from the
 * caller's clock rather than read from `CURRENT_TIMESTAMP`, because the service
 * injects a clock so expiry and revocation are deterministic under test.
 *
 * The `kind`, `resource` and `grant_id` columns were added for OAuth tokens
 * (mcp-gateway-SPEC stage 5, AC-258); a PAT insert that omits them still lands a
 * `pat` row with an empty resource and a NULL grant, so the pre-existing PAT
 * callers are unchanged.
 *
 * Consumers: server/modules/oauth (access-tokens.service.ts,
 * oauth-store.service.ts) and server/modules/settings (settings.module.ts, for
 * the /access-tokens routes), both through the database module barrel.
 */

import { getConnection } from '@/modules/database/core/index.js';

/** A persisted access-token row exactly as stored; `scopes` is a JSON array string. */
export type AccessTokenRow = {
  id: number;
  user_id: number;
  kind: string;
  token_hash: string;
  token_prefix: string;
  name: string | null;
  grant_id: number | null;
  scopes: string;
  resource: string;
  expires_at: string;
  created_at: string | null;
  last_used: string | null;
  revoked_at: string | null;
};

/**
 * The fields a caller supplies to insert a token row; all timestamps are ISO
 * strings. `kind` defaults to `'pat'`, `resource` to `''` and `grantId` to NULL,
 * so a PAT insert supplies none of them and an OAuth insert supplies all three.
 */
export type InsertAccessTokenInput = {
  userId: number;
  tokenHash: string;
  tokenPrefix: string;
  name: string | null;
  scopes: string;
  expiresAt: string;
  createdAt: string;
  kind?: string;
  resource?: string;
  grantId?: number | null;
};

const TOKEN_COLUMNS =
  'id, user_id, kind, token_hash, token_prefix, name, grant_id, scopes, resource, expires_at, created_at, last_used, revoked_at';

export const accessTokensDb = {
  /** Inserts a token row and returns its new id. */
  insert(input: InsertAccessTokenInput): number {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO access_tokens
           (user_id, token_hash, token_prefix, name, scopes, expires_at, created_at, kind, resource, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.userId,
        input.tokenHash,
        input.tokenPrefix,
        input.name,
        input.scopes,
        input.expiresAt,
        input.createdAt,
        input.kind ?? 'pat',
        input.resource ?? '',
        input.grantId ?? null
      );
    return Number(result.lastInsertRowid);
  },

  /**
   * Lists the token rows owned by `userId`, newest first. Used by the settings
   * module's `/access-tokens` list; the caller projects away `token_hash`, which
   * this read deliberately includes so the projection is the caller's explicit
   * allowlist rather than an accidental omission.
   *
   * `kind` narrows the read to a single token kind at the SQL layer. The settings
   * PAT list passes `'pat'` so the OAuth tokens the OAuth store writes (whose
   * `name` is NULL) can never appear in it; the MCP-audit reader and the settings
   * OAuth-token list omit it and receive every kind, because an OAuth token
   * makes MCP calls too.
   */
  listByUser(userId: number, kind?: string): AccessTokenRow[] {
    const db = getConnection();
    if (kind === undefined) {
      return db
        .prepare(`SELECT ${TOKEN_COLUMNS} FROM access_tokens WHERE user_id = ? ORDER BY id DESC`)
        .all(userId) as AccessTokenRow[];
    }
    return db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM access_tokens WHERE user_id = ? AND kind = ? ORDER BY id DESC`)
      .all(userId, kind) as AccessTokenRow[];
  },

  /** Finds a token by its row id; undefined when no row matches. Used to check ownership before revocation. */
  findById(id: number): AccessTokenRow | undefined {
    const db = getConnection();
    return db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM access_tokens WHERE id = ?`)
      .get(id) as AccessTokenRow | undefined;
  },

  /** Finds a token by its SHA-256 hash; undefined when no row matches. */
  findByHash(tokenHash: string): AccessTokenRow | undefined {
    const db = getConnection();
    return db
      .prepare(`SELECT ${TOKEN_COLUMNS} FROM access_tokens WHERE token_hash = ?`)
      .get(tokenHash) as AccessTokenRow | undefined;
  },

  /**
   * Records the instant a token was last accepted. Consumers: the OAuth module's
   * `access-tokens.service.ts` (PAT `verifyToken`) and `oauth-provider.service.ts`
   * (OAuth `verifyAccessToken`). Both gate the call on `lastUsedStamp`, so a hot
   * `/mcp` stream writes at most once per throttle window rather than per request.
   */
  updateLastUsed(id: number, lastUsed: string): void {
    const db = getConnection();
    db.prepare('UPDATE access_tokens SET last_used = ? WHERE id = ?').run(lastUsed, id);
  },

  /**
   * Revokes a live token by id. Returns true only when a not-yet-revoked row
   * matched, so a second revocation does not overwrite the first timestamp.
   */
  revoke(id: number, revokedAt: string): boolean {
    const db = getConnection();
    const result = db
      .prepare('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, id);
    return result.changes > 0;
  },

  /**
   * Revokes every live token under `grantId` — the cascade behind revoking a
   * grant or disabling the client that owns it. Returns the number of rows
   * changed, so the caller can report how many tokens the cascade rejected.
   */
  revokeByGrantId(grantId: number, revokedAt: string): number {
    const db = getConnection();
    const result = db
      .prepare('UPDATE access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL')
      .run(revokedAt, grantId);
    return result.changes;
  },
};
