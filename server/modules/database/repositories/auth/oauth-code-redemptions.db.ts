/**
 * OAuth authorization-code redemption ledger repository.
 *
 * Persists the mapping from a consumed authorization code to the grant it
 * authorized. `oauth_authorization_codes` is built verbatim from the SPEC DDL and
 * carries no `grant_id`, but AC-259's single-use rule must revoke the whole
 * authorization a replayed code already issued — and the codes row is deleted on
 * a successful exchange, so the mapping cannot live there. This ledger survives
 * the delete: `redeemed_at` is NULL while a code is outstanding and stamped when
 * it is exchanged, so a later replay of the same hash resolves to `grant_id` and
 * the grant can be revoked.
 *
 * Only the code's SHA-256 hash is stored. Consumers:
 * server/modules/oauth/oauth-provider.service.ts, through the database module
 * barrel.
 */

import { getConnection } from '@/modules/database/core/index.js';

/** A persisted redemption-ledger row exactly as stored. */
export type OAuthCodeRedemptionRow = {
  code_hash: string;
  grant_id: number;
  redeemed_at: string | null;
};

/** The fields a caller supplies to record a freshly issued code. */
export type InsertOAuthCodeRedemptionInput = {
  codeHash: string;
  grantId: number;
};

const REDEMPTION_COLUMNS = 'code_hash, grant_id, redeemed_at';

export const oauthCodeRedemptionsDb = {
  /**
   * Records a newly issued code against the grant it will authorize, with
   * `redeemed_at` left NULL. Written in the same flow as the code row itself.
   */
  insert(input: InsertOAuthCodeRedemptionInput): void {
    getConnection()
      .prepare(
        `INSERT INTO oauth_code_redemptions (code_hash, grant_id, redeemed_at)
         VALUES (?, ?, NULL)`
      )
      .run(input.codeHash, input.grantId);
  },

  /** Finds a ledger row by the code's SHA-256 hash; undefined when no row matches. */
  findByHash(codeHash: string): OAuthCodeRedemptionRow | undefined {
    return getConnection()
      .prepare(`SELECT ${REDEMPTION_COLUMNS} FROM oauth_code_redemptions WHERE code_hash = ?`)
      .get(codeHash) as OAuthCodeRedemptionRow | undefined;
  },

  /**
   * Stamps a code as redeemed. Returns true only when an outstanding row matched,
   * so a second stamp does not overwrite the first timestamp.
   */
  markRedeemed(codeHash: string, redeemedAt: string): boolean {
    const result = getConnection()
      .prepare(
        'UPDATE oauth_code_redemptions SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL'
      )
      .run(redeemedAt, codeHash);
    return result.changes > 0;
  },
};
