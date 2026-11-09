/**
 * MCP tool-call audit-log repository (AC-244).
 *
 * Persists one row per MCP tool invocation (mcp-gateway-SPEC §389). The writer is
 * the mcp-gateway module's audit wrapper, which reduces the tool arguments to a
 * digest before calling here — this repository stores whatever `argsDigest` it is
 * handed and never inspects the arguments itself.
 *
 * `at` is caller-supplied when given (the retention criterion plants rows days
 * old to exercise the sweep) and falls back to the column's `CURRENT_TIMESTAMP`
 * default, matching how the audit wrapper writes "now" without reading the clock
 * twice. `deleteOlderThan` deletes strictly before the cutoff, so a row exactly
 * on the boundary is retained.
 *
 * Consumers: server/modules/mcp-gateway (mcp-gateway.audit.ts, which writes the
 * rows) and server/modules/settings (via the mcp-audit reader's
 * `listRowsForTokens` seam, which reads one user's rows back for the MCP-audit
 * settings page), both through the database module barrel.
 */

import { getConnection } from '@/modules/database/core/index.js';

/** A persisted audit row exactly as stored. `outcome` is 'ok' | 'denied' | 'error'. */
export type McpAuditLogRow = {
  id: number;
  at: string;
  token_id: number | null;
  client_id: string | null;
  tool: string;
  args_digest: string | null;
  outcome: string;
  duration_ms: number | null;
  /**
   * AC-286: the JSON array of scopes a `denied` row's caller was missing, or
   * null on every other outcome. Stored as text (the table column is TEXT); a
   * reader that wants the list parses it.
   */
  denied_scopes: string | null;
  /**
   * gap-mcp-usage-stats: the machine error code an `error` (or code-stamped
   * `denied`) row carried — e.g. `INVALID_ARGUMENT` — or null on `ok` and on a
   * denial with no code. A reader that groups by `error_code` reads this column.
   */
  error_code: string | null;
  /** gap-mcp-usage-stats: the UTF-8 byte length of the serialized success payload, or null on failure. */
  response_bytes: number | null;
  /** gap-mcp-usage-stats: a nullable correlation seam (AC-337 owns filling it); null until then. */
  correlation_id: string | null;
};

/**
 * The fields a caller supplies to insert a row. `at` is optional: when omitted
 * the column default (`CURRENT_TIMESTAMP`) is used, so the audit wrapper does not
 * have to read the clock just to stamp the row. `deniedScopes` is optional too —
 * only a scope denial supplies it, and it is serialized to a JSON array here so
 * the caller passes the list, never a hand-encoded string. `errorCode` and
 * `responseBytes` (gap-mcp-usage-stats) are optional for the same reason: an `ok`
 * row has no code, a failure row has no payload size.
 */
export type InsertMcpAuditLogInput = {
  at?: string;
  tokenId: number | null;
  clientId: string | null;
  tool: string;
  argsDigest: string | null;
  outcome: string;
  durationMs: number | null;
  deniedScopes?: readonly string[] | null;
  errorCode?: string | null;
  responseBytes?: number | null;
  correlationId?: string | null;
};

const AUDIT_COLUMNS =
  'id, at, token_id, client_id, tool, args_digest, outcome, duration_ms, denied_scopes, error_code, response_bytes, correlation_id';

export const mcpAuditLogDb = {
  /**
   * Inserts one audit row and returns its new id. `at` is honoured when the
   * caller passes it; otherwise `COALESCE(?, CURRENT_TIMESTAMP)` uses the
   * column's default, so an omitted timestamp is the insert instant.
   * `deniedScopes` is serialized to a JSON array (null when absent), so the
   * stored `denied_scopes` is text the caller never has to encode by hand. The
   * telemetry tail (`errorCode` / `responseBytes` / `correlationId`) is stored
   * verbatim, each defaulting to null when the caller omits it.
   */
  insert(input: InsertMcpAuditLogInput): number {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO mcp_audit_log
           (at, token_id, client_id, tool, args_digest, outcome, duration_ms, denied_scopes,
            error_code, response_bytes, correlation_id)
         VALUES (COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.at ?? null,
        input.tokenId,
        input.clientId,
        input.tool,
        input.argsDigest,
        input.outcome,
        input.durationMs,
        input.deniedScopes && input.deniedScopes.length > 0 ? JSON.stringify(input.deniedScopes) : null,
        input.errorCode ?? null,
        input.responseBytes ?? null,
        input.correlationId ?? null
      );
    return Number(result.lastInsertRowid);
  },

  /** Total number of audit rows. The criterion reads this before/after each call. */
  count(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) AS count FROM mcp_audit_log').get() as { count: number };
    return row.count;
  },

  /**
   * Every audit row, oldest first. Consumers: the criterion, which reassembles
   * all columns of a row to prove the full free text appears in none of them.
   */
  allRows(): McpAuditLogRow[] {
    const db = getConnection();
    return db.prepare(`SELECT ${AUDIT_COLUMNS} FROM mcp_audit_log ORDER BY id ASC`).all() as McpAuditLogRow[];
  },

  /**
   * The audit rows belonging to any of `tokenIds`, newest first, bounded to
   * `options.limit` rows.
   *
   * Ownership is expressed as a token-id set because the audit table stores
   * `token_id`/`client_id` and has no `user_id` (AC-244's shape is deliberately
   * unchanged); the caller resolves a user to its token ids. An empty
   * `tokenIds` returns `[]` WITHOUT running a query — an `IN ()` predicate is a
   * syntax error, and "this user owns no tokens" is already the correct answer.
   *
   * `options.excludeTools` appends `AND tool NOT IN (...)` INSIDE the same
   * statement as `LIMIT`, so the limit counts the rows the caller will actually
   * receive (the default write-only view counts write rows, not rows that a
   * later JS filter would have discarded).
   *
   * Pure read: it classifies nothing, parses no digest, and reads no clock.
   * `ORDER BY at DESC, id DESC` breaks ties between rows written in the same
   * second by insertion order, so the order is total and stable. Consumers:
   * the settings module's MCP-audit reader, through the database module barrel.
   */
  listForTokens(tokenIds: number[], options: { limit: number; excludeTools?: readonly string[] }): McpAuditLogRow[] {
    if (tokenIds.length === 0) {
      return [];
    }
    const params: unknown[] = [...tokenIds];
    const placeholders = tokenIds.map(() => '?').join(', ');
    let sql = `SELECT ${AUDIT_COLUMNS} FROM mcp_audit_log WHERE token_id IN (${placeholders})`;
    const excludeTools = options.excludeTools ?? [];
    if (excludeTools.length > 0) {
      sql += ` AND tool NOT IN (${excludeTools.map(() => '?').join(', ')})`;
      params.push(...excludeTools);
    }
    sql += ' ORDER BY at DESC, id DESC LIMIT ?';
    params.push(options.limit);
    return getConnection().prepare(sql).all(...params) as McpAuditLogRow[];
  },

  /**
   * Deletes every row whose `at` is strictly before `cutoffIso`, returning the
   * number removed. Strict `<` is deliberate: the retention window keeps a row
   * exactly `retentionDays` old.
   */
  deleteOlderThan(cutoffIso: string): number {
    const db = getConnection();
    const result = db.prepare('DELETE FROM mcp_audit_log WHERE at < ?').run(cutoffIso);
    return result.changes;
  },
};
