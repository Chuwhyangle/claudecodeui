/**
 * The MCP gateway's `mcp_usage_stats` handler (gap-mcp-usage-stats / AC-334).
 *
 * The tool answers "how is this gateway being used, and how is it failing" for
 * the CALLING USER — per tool, per error code, or per OAuth client — with the
 * counters and latency/size quantiles an operator needs to see a regression
 * without reading individual calls. It is the aggregate companion to AC-334's
 * audit columns: `error_code` and `response_bytes` exist so this tool can group
 * and quantile over them.
 *
 * ## The user boundary is enforced in SQL
 *
 * `mcp_audit_log` stores `token_id`/`client_id` and has no `user_id` (AC-244's
 * shape is deliberately unchanged), so "this user's calls" is expressed as a
 * JOIN onto `access_tokens` on `token_id` and a `WHERE access_tokens.user_id =
 * ?` predicate. Two personal access tokens of the SAME user therefore aggregate
 * together, and a second user's rows are invisible — the filter is by the
 * token's OWNER, never by `client_id` (a user may call through several clients)
 * and never by the caller's token id alone (that would split one user's calls
 * across its tokens). Rows with a null `token_id` (unauthenticated denials) join
 * nothing and are correctly excluded: no user owns them.
 *
 * ## Nearest-rank quantiles, stated in the description
 *
 * `p50`/`p95` (and `bytesP50`/`bytesP95`) use the nearest-rank definition —
 * `sorted[ceil(p * n) - 1]` over the ASCENDING values — the same one
 * `mcp-resolve-target`'s family already uses. It is a real order statistic, not
 * an interpolation, so every reading is a value that actually occurred; the
 * tool's description says so, because "p95" without a definition is ambiguous.
 * A group with no value of the measured kind (e.g. a group of failures, which
 * carry no `response_bytes`) reports `null`, never a fabricated 0.
 *
 * ## No bodies, ever
 *
 * The tool reads only `tool`, `outcome`, `error_code`, `client_id`,
 * `duration_ms` and `response_bytes`. It never selects `args_digest`, and the
 * audit writer stores only a summary of the arguments — so neither this
 * aggregate nor the rows behind it can carry a caller's argument or result text.
 * AC-334 (d) is the reading that proves the marker string a fixture plants in a
 * `session_send` body appears in neither.
 *
 * ## What it depends on
 *
 * Only the SQLite connection and the request principal. It takes no
 * {@link McpReadToolDeps} service, which is why its implementation lives here
 * rather than inline in `mcp-gateway.read-tools.ts`; the read table still owns
 * its name, scope and description, so registration is the same one statement as
 * every other stage-3 tool.
 */

import { z } from 'zod';

import { getConnection } from '@/modules/database/index.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';

/** The tool's registered name. Declared here so the read table and this module name it once. */
export const MCP_USAGE_STATS_TOOL_NAME = 'mcp_usage_stats';

/**
 * The client-facing description. States the user boundary, the three groupings,
 * the nearest-rank quantile definition and the fact that argument/result
 * bodies are never read — the four things a caller must know to read the answer
 * honestly. English (mcp-english-only).
 */
export const MCP_USAGE_STATS_DESCRIPTION =
  'Aggregate THIS caller\'s own MCP tool-call telemetry over the audit log: one row per group, ' +
  'with call counts and latency/size quantiles. Group by "tool" (per tool name), "error_code" ' +
  '(per failure code; successful calls group under a null key) or "client" (per OAuth client id; ' +
  'personal access tokens group under a null key). Optionally bound the window with "since" and ' +
  '"until" (ISO 8601 instants, inclusive). Only the rows written under tokens OWNED BY THE CALLING ' +
  'USER are counted — another user\'s calls are never included, and a user\'s several tokens ' +
  'aggregate together. Quantiles p50/p95 (and bytesP50/bytesP95 over the response payload size) ' +
  'use the nearest-rank method: the value at position ceil(p*n) of the ascending values, so each ' +
  'reading is a value that occurred, never an interpolation; a group with no such value reports ' +
  'null. Argument and result BODIES are never read or returned — only counts and numeric summaries.';

/**
 * The input shape. `groupBy` is REQUIRED and has no default: there is no
 * harmless way to guess what a caller wants grouped, so omitting it is an
 * `INVALID_ARGUMENT` rather than a silent "group by tool". `since`/`until` are
 * optional ISO 8601 instants; the handler parses them and rejects a malformed
 * one.
 */
export const MCP_USAGE_STATS_INPUT_SCHEMA = {
  since: z.string().optional(),
  until: z.string().optional(),
  groupBy: z.enum(['tool', 'error_code', 'client']),
} satisfies z.ZodRawShape;

/** One group's reading: the three counters, latency quantiles and payload-size quantiles. */
const usageStatsGroupSchema = z.object({
  /** The group's key — a tool name, an error code, a client id, or null (see the description). */
  key: z.string().nullable(),
  /** Total calls in the group. */
  n: z.number(),
  /** Calls that ended `ok`. */
  ok: z.number(),
  /** Calls that ended `error`. */
  error: z.number(),
  /** Calls refused for a missing scope (or another `denied` reading). */
  denied: z.number(),
  /** Nearest-rank latency quantiles, in milliseconds; null when the group has no timed call. */
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  /** The slowest call in the group, in milliseconds; null when the group has no timed call. */
  max: z.number().nullable(),
  /** Nearest-rank quantiles of the serialized success-payload byte length; null when none succeeded. */
  bytesP50: z.number().nullable(),
  bytesP95: z.number().nullable(),
});

/** The tool's declared output. The wrapper optionalizes the top level; the group fields stay required. */
export const MCP_USAGE_STATS_OUTPUT_SCHEMA = {
  groupBy: z.enum(['tool', 'error_code', 'client']),
  since: z.string().nullable(),
  until: z.string().nullable(),
  /** Sum of every group's `n`, so a caller reads the grand total without adding the rows. */
  total: z.number(),
  groups: z.array(usageStatsGroupSchema),
} satisfies z.ZodRawShape;

/** One `groupBy` value, as the SQL grouping column and the output `key`. */
export type McpUsageStatsGroupBy = 'tool' | 'error_code' | 'client';

/** A validated input, after the handler reads it off the wire. */
export type McpUsageStatsInput = {
  groupBy: McpUsageStatsGroupBy;
  since: string | null;
  until: string | null;
};

/** One aggregate group, exactly as it is returned. */
export type McpUsageStatsGroup = z.infer<typeof usageStatsGroupSchema>;

/** The whole reading. */
export type McpUsageStatsResult = {
  groupBy: McpUsageStatsGroupBy;
  since: string | null;
  until: string | null;
  total: number;
  groups: McpUsageStatsGroup[];
};

/** The audit column a `groupBy` groups on. `client` reads `client_id` (the OAuth client). */
const GROUP_COLUMN: Record<McpUsageStatsGroupBy, string> = {
  tool: 'a.tool',
  error_code: 'a.error_code',
  client: 'a.client_id',
};

/**
 * Normalizes an ISO 8601 instant to the exact shape `CURRENT_TIMESTAMP` writes
 * (`YYYY-MM-DD HH:MM:SS`, UTC), so the `at` range predicate is a plain string
 * comparison against the stored column — appending a `T`-separated ISO string
 * would compare wrongly at the date/time boundary. A malformed instant is an
 * `INVALID_ARGUMENT`, never a silently ignored bound.
 */
function toAuditTimestamp(value: string, argument: 'since' | 'until'): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      `"${argument}" must be a valid ISO 8601 instant.`,
    );
  }
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

/** Reads and validates the tool's arguments. `groupBy` is required and already enum-checked by the wrapper. */
export function readUsageStatsInput(args: Record<string, unknown>): McpUsageStatsInput {
  const groupBy = args.groupBy;
  if (groupBy !== 'tool' && groupBy !== 'error_code' && groupBy !== 'client') {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"groupBy" is required and must be one of "tool", "error_code", "client".',
    );
  }
  const since = typeof args.since === 'string' ? toAuditTimestamp(args.since, 'since') : null;
  const until = typeof args.until === 'string' ? toAuditTimestamp(args.until, 'until') : null;
  return { groupBy, since, until };
}

/**
 * The nearest-rank order statistic: the value at 1-based position `ceil(p*n)`
 * of the ASCENDING `values`. Purely positional — never an interpolation — so
 * every reading is a value that occurred. An empty series has no reading, so it
 * answers `null` rather than a fabricated 0.
 */
function nearestRank(ascending: readonly number[], p: number): number | null {
  if (ascending.length === 0) {
    return null;
  }
  const position = Math.min(Math.max(Math.ceil(p * ascending.length), 1), ascending.length);
  return ascending[position - 1];
}

/** One raw scoped row, as the aggregation reads it. Only numeric/identify columns — never a body. */
type ScopedAuditRow = {
  grp: string | null;
  outcome: string;
  duration_ms: number | null;
  response_bytes: number | null;
};

/**
 * Runs the user-scoped read and reduces it to one group per `groupBy` value.
 *
 * The SQL does the security-relevant work — the JOIN onto `access_tokens` and
 * the `user_id` predicate, plus the optional `at` window — so a second user's
 * rows never leave the database. The counting and the nearest-rank quantiles are
 * computed here, where the definition is one function rather than a second SQL
 * dialect to prove.
 */
function aggregateUsageStats(principal: McpPrincipal, input: McpUsageStatsInput): McpUsageStatsResult {
  const params: unknown[] = [principal.userId];
  let sql = `
    SELECT ${GROUP_COLUMN[input.groupBy]} AS grp,
           a.outcome AS outcome,
           a.duration_ms AS duration_ms,
           a.response_bytes AS response_bytes
    FROM mcp_audit_log AS a
    JOIN access_tokens AS t ON t.id = a.token_id
    WHERE t.user_id = ?`;
  if (input.since !== null) {
    sql += ' AND a.at >= ?';
    params.push(input.since);
  }
  if (input.until !== null) {
    sql += ' AND a.at <= ?';
    params.push(input.until);
  }
  sql += ' ORDER BY a.id ASC';

  const rows = getConnection().prepare(sql).all(...params) as ScopedAuditRow[];

  const byKey = new Map<string | null, ScopedAuditRow[]>();
  for (const row of rows) {
    const bucket = byKey.get(row.grp);
    if (bucket === undefined) {
      byKey.set(row.grp, [row]);
    } else {
      bucket.push(row);
    }
  }

  const groups: McpUsageStatsGroup[] = [];
  for (const [key, bucket] of byKey) {
    let ok = 0;
    let error = 0;
    let denied = 0;
    const durations: number[] = [];
    const bytes: number[] = [];
    for (const row of bucket) {
      if (row.outcome === 'ok') ok += 1;
      else if (row.outcome === 'error') error += 1;
      else if (row.outcome === 'denied') denied += 1;
      if (typeof row.duration_ms === 'number') durations.push(row.duration_ms);
      if (typeof row.response_bytes === 'number') bytes.push(row.response_bytes);
    }
    durations.sort((left, right) => left - right);
    bytes.sort((left, right) => left - right);
    groups.push({
      key,
      n: bucket.length,
      ok,
      error,
      denied,
      p50: nearestRank(durations, 0.5),
      p95: nearestRank(durations, 0.95),
      max: durations.length === 0 ? null : durations[durations.length - 1],
      bytesP50: nearestRank(bytes, 0.5),
      bytesP95: nearestRank(bytes, 0.95),
    });
  }

  // Deterministic order: keys ascending, a null key last (it is the "no client /
  // no error code" bucket), so two reads of an unchanged log answer identically.
  groups.sort((left, right) => {
    if (left.key === right.key) return 0;
    if (left.key === null) return 1;
    if (right.key === null) return -1;
    return left.key < right.key ? -1 : 1;
  });

  return {
    groupBy: input.groupBy,
    since: input.since,
    until: input.until,
    total: rows.length,
    groups,
  };
}

/**
 * The `mcp_usage_stats` handler. `principal` is the request's authenticated
 * caller; the wrapper denies a null principal before any handler runs, so the
 * guard here is a typed envelope rather than a crash if that ever changes.
 *
 * Delegates the whole reading to {@link aggregateUsageStats}, which is the only
 * place the user boundary and the quantiles are stated.
 */
export function runMcpUsageStats(
  args: Record<string, unknown>,
  principal: McpPrincipal | null,
): McpUsageStatsResult {
  if (principal === null) {
    throw new McpToolError(
      MCP_ERROR_CODES.INTERNAL_ERROR,
      'The usage stats tool requires an authenticated caller.',
    );
  }
  return aggregateUsageStats(principal, readUsageStatsInput(args));
}
