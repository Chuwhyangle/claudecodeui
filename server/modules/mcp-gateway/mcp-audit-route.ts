/**
 * MCP tool-call audit READBACK (AC-304).
 *
 * The write side (AC-244) persists one row per tool invocation with the
 * arguments already reduced to a digest. This module is the read side: it
 * projects one user's recent rows into the shape the settings page renders,
 * WITHOUT re-summarizing anything — the `summary` is the digest the audit row
 * already holds, parsed back. "The summary follows the audit table's rule" means
 * "reuse the stored digest", not "apply a second cut"; a future reviewer who
 * expects truncation here should read this comment and find it deliberate.
 *
 * Ownership is by TOKEN, not by a `user_id` column: the audit table has only
 * `token_id`/`client_id` (AC-244's shape is left alone), so a user's rows are the
 * rows whose `token_id` is one of that user's tokens. The token-id list is an
 * injected seam so this module never imports the OAuth module directly.
 *
 * Consumers: server/modules/settings (settings.module.ts assembles
 * `createMcpAuditReader` over the real database seams and hands it to the
 * settings service) and this module's criterion, which drives the reader both
 * directly and through the production settings route.
 */

import type { McpAuditLogRow } from '@/modules/database/index.js';

import { MCP_TOOL_ANNOTATIONS } from './mcp-tool-annotations.js';

/** Rows returned when the caller does not ask for a limit. */
export const MCP_AUDIT_ROUTE_DEFAULT_LIMIT = 50;
/** The floor a requested limit is clamped to, so a request can never return zero rows. */
export const MCP_AUDIT_ROUTE_MIN_LIMIT = 1;
/** The ceiling a requested limit is clamped to, so one page stays bounded. */
export const MCP_AUDIT_ROUTE_MAX_LIMIT = 200;

/**
 * One audit row as the settings page reads it. Deliberately narrower than
 * {@link McpAuditLogRow}: `token_id` / `client_id` / any token secret are absent
 * by construction, so a response can never leak which token made the call.
 * `clientName` is the display name resolved from the row's attribution.
 *
 * `durationMs` is the row's own `duration_ms` (gap-mcp-session-get-past-
 * recents-page-and-small-envelope-defects): how long the audited call took, so a
 * caller can see the cost of a call it already knew the shape of. Null when the
 * stored row carries no timing.
 */
export type McpAuditRouteEntry = {
  at: string;
  clientName: string | null;
  tool: string;
  outcome: string;
  durationMs: number | null;
  summary: unknown;
};

/**
 * The tool names declared read-only in the gateway's ONE annotations table —
 * derived, never a second hard-coded list. Passed as `excludeTools` so the
 * default view ("writes only") is filtered in SQL, where the `LIMIT` counts the
 * write rows the caller will receive.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(MCP_TOOL_ANNOTATIONS)
    .filter(([, annotations]) => annotations.readOnlyHint === true)
    .map(([name]) => name),
);

/**
 * Normalizes a caller-supplied `limit`. Pure: no clock, no I/O.
 *
 * A non-integer (including `undefined`, an empty or whitespace string, and a
 * non-numeric string) falls back to {@link MCP_AUDIT_ROUTE_DEFAULT_LIMIT};
 * anything else is clamped into `[MIN, MAX]`. Query strings arrive as strings, so
 * `'0'` and `'-5'` are integers and clamp to the {@link MCP_AUDIT_ROUTE_MIN_LIMIT}
 * floor rather than being read as "no rows".
 *
 * Consumers: {@link createMcpAuditReader} and this module's criterion, which
 * asserts the default, the two clamps and the floor directly.
 */
export function readMcpAuditLimit(value: unknown): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value);
  } else {
    return MCP_AUDIT_ROUTE_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(parsed)) {
    return MCP_AUDIT_ROUTE_DEFAULT_LIMIT;
  }
  return Math.min(MCP_AUDIT_ROUTE_MAX_LIMIT, Math.max(MCP_AUDIT_ROUTE_MIN_LIMIT, parsed));
}

/**
 * Parses a stored `args_digest` back into the `summary` the response carries.
 * `null` stays `null`; a digest that will not parse is returned as its raw
 * string rather than dropped, so a malformed row is still visible. No second
 * summarization happens here — the row's digest is already the audited form.
 */
function parseArgsDigest(argsDigest: string | null): unknown {
  if (argsDigest === null) {
    return null;
  }
  try {
    return JSON.parse(argsDigest) as unknown;
  } catch {
    return argsDigest;
  }
}

/**
 * The seams {@link createMcpAuditReader} reads, all injectable so the reader has
 * no direct database or OAuth dependency. The production bindings live in
 * `server/modules/settings/settings.module.ts`.
 */
export type McpAuditReadDeps = {
  /** The ids of every access token owned by `userId`. */
  listTokenIdsForUser(userId: number): number[];
  /** The user's rows, newest first, bounded to `limit`; `excludeTools` is applied inside the query. */
  listRowsForTokens(tokenIds: number[], limit: number, excludeTools: readonly string[]): McpAuditLogRow[];
  /** The display name for a row's attribution; null when the row cannot be attributed. */
  resolveClientName(row: McpAuditLogRow): string | null;
};

/**
 * Builds the settings page's MCP-audit reader.
 *
 * `listForUser` resolves the user's token ids, reads the bounded rows (excluding
 * the annotated read-only tools unless `includeReads` was truthy), and projects
 * each row to {@link McpAuditRouteEntry}. `includeReads` accepts the boolean the
 * service passes through and the string a raw query yields.
 *
 * Consumers: `settings.module.ts` (the production assembly) and this module's
 * criterion.
 */
export function createMcpAuditReader(deps: McpAuditReadDeps) {
  return {
    listForUser(input: { userId: number; limit?: unknown; includeReads?: unknown }): McpAuditRouteEntry[] {
      const limit = readMcpAuditLimit(input.limit);
      const includeReads = input.includeReads === true || input.includeReads === 'true';
      const excludeTools = includeReads ? [] : [...READ_ONLY_TOOL_NAMES];
      const tokenIds = deps.listTokenIdsForUser(input.userId);
      const rows = deps.listRowsForTokens(tokenIds, limit, excludeTools);
      return rows.map((row) => ({
        at: row.at,
        clientName: deps.resolveClientName(row),
        tool: row.tool,
        outcome: row.outcome,
        durationMs: row.duration_ms,
        summary: parseArgsDigest(row.args_digest),
      }));
    },
  };
}
