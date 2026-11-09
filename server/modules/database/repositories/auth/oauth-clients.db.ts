/**
 * OAuth client repository.
 *
 * Persists RFC 7591 client registrations. Only the SHA-256 hash of a
 * confidential client's secret is ever stored (`client_secret_hash` is NULL for
 * a public, PKCE-only client); the plaintext secret is generated and returned
 * once by the OAuth store service and never reaches this table. `redirect_uris`
 * and `metadata` are JSON documents the caller serializes.
 *
 * Consumers: server/modules/oauth/oauth-store.service.ts, through the database
 * module barrel.
 */

import { getConnection } from '@/modules/database/core/index.js';

/** A persisted OAuth client row exactly as stored; JSON columns stay raw strings. */
export type OAuthClientRow = {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string;
  metadata: string;
  created_via: string;
  created_at: string | null;
  disabled_at: string | null;
};

/** The fields a caller supplies to insert a client row; JSON fields are pre-serialized. */
export type InsertOAuthClientInput = {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string;
  metadata: string;
  createdVia: string;
  createdAt: string;
};

const CLIENT_COLUMNS =
  'client_id, client_secret_hash, client_name, redirect_uris, metadata, created_via, created_at, disabled_at';

export const oauthClientsDb = {
  /** Inserts a client registration row. */
  insert(input: InsertOAuthClientInput): void {
    getConnection()
      .prepare(
        `INSERT INTO oauth_clients
           (client_id, client_secret_hash, client_name, redirect_uris, metadata, created_via, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.clientId,
        input.clientSecretHash,
        input.clientName,
        input.redirectUris,
        input.metadata,
        input.createdVia,
        input.createdAt
      );
  },

  /** Finds a client by its public id; undefined when no row matches. */
  findById(clientId: string): OAuthClientRow | undefined {
    return getConnection()
      .prepare(`SELECT ${CLIENT_COLUMNS} FROM oauth_clients WHERE client_id = ?`)
      .get(clientId) as OAuthClientRow | undefined;
  },

  /**
   * Disables a client. Returns true only when a not-yet-disabled row matched, so
   * a second disable does not overwrite the first timestamp.
   */
  disable(clientId: string, disabledAt: string): boolean {
    const result = getConnection()
      .prepare('UPDATE oauth_clients SET disabled_at = ? WHERE client_id = ? AND disabled_at IS NULL')
      .run(disabledAt, clientId);
    return result.changes > 0;
  },

  /** Every client row; used by the criterion's whole-database hash scan. */
  allRows(): OAuthClientRow[] {
    return getConnection()
      .prepare(`SELECT ${CLIENT_COLUMNS} FROM oauth_clients ORDER BY client_id`)
      .all() as OAuthClientRow[];
  },
};
