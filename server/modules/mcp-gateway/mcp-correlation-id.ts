/**
 * The optional `correlationId` correlation label (AC-337).
 *
 * A caller may attach an opaque label to the calls it makes so that the calls it
 * made for one logical piece of work can be read back together. The label is
 * deliberately NOT an entity: the gateway never creates a row for it, never
 * creates a join on it, never schedules anything from it and never advances any
 * state by reading it. It is stored in exactly two places — the in-memory
 * delivery a send was accepted as, held by the run registry and resolved back to
 * the run that owns that delivery (so `sessions_list` can narrow to the sessions
 * carrying it), and the `mcp_audit_log.correlation_id` column AC-334 opened (so
 * `mcp_usage_stats` can aggregate the calls that carry it) — and both of those
 * readings are pure filters over state that already existed. S3 (SPEC §6.1) moved
 * the first of the two from the run onto the delivery, because a resident send
 * has no run yet when its label arrives and only the delivery id exists to
 * address it by; the registry's `listRunningRuns` reads it back through the
 * run's owner delivery, so a label-addressed query is unchanged.
 *
 * That is why this module holds no table, no timer and no cache: the whole
 * feature is one declared field, one sentence of description and one reading
 * predicate, and the absence of anything else is what AC-337 (d) asserts.
 *
 * ## The charset and the length are the ONE statement of the field
 *
 * {@link MCP_CORRELATION_ID_INPUT_FIELD} is a Zod field, and it is the single
 * declaration every accepting tool's `inputSchema` splices in. Because the
 * audited wrapper hands each tool's declared schema BOTH to the SDK (so
 * `tools/list` advertises it) and to its own validator (AC-288 (f)), a label
 * outside the declared contract is answered as an `INVALID_ARGUMENT` envelope
 * whose `details.fields[].path` is literally `correlationId` — a too-long or
 * illegal label names itself, with no per-tool validation code (AC-337 (e)).
 *
 * The charset is the intersection of what every label producer this gateway can
 * see already emits: a UUID (`-`), a trace/span id (`-`, `_`), a W3C
 * `traceparent` fragment (`-`), a dotted release name (`.`), an ISO instant
 * (`.`, `:`) and a colon-separated prefix (`:`). It excludes whitespace,
 * control characters and every character that would need escaping in a header,
 * a log line or a SQL parameter — so the value is safe to echo into the audit
 * row, a log line and an envelope `message` without a second escaping rule.
 *
 * ## Why the reader is permissive and the schema is not
 *
 * {@link readCorrelationId} never throws: it answers `null` for an absent,
 * non-string, too-long or illegal value. The enforcement point is the declared
 * schema, which runs BEFORE any handler (AC-288's dispatcher) and therefore
 * before this reader on every wire path. The reader being permissive is what
 * keeps a handler that is invoked directly (a criterion, a future internal
 * caller) from turning an unusable label into a crash, and it is what makes "no
 * label" and "a label a handler cannot use" the same reading — `null` — for
 * every consumer that only wants to know whether there is something to store.
 *
 * Consumers: `mcp-session-send.ts` and `mcp-session-lifecycle.ts` (the two
 * builders that stamp a run), `mcp-gateway.audit.ts` (the audit row),
 * `mcp-gateway.read-tools.ts`'s `sessions_list` and `mcp-usage-stats.ts` (the
 * two filters), and this task's criterion.
 */

import { z } from 'zod';

/** The shortest usable label. An empty string is not a label, it is an absence. */
export const MCP_CORRELATION_ID_MIN_LENGTH = 1;

/**
 * The longest usable label. Bounded so the value stays a label rather than a
 * payload: a caller cannot smuggle a body into the audit row or an envelope
 * through it, and `INVALID_ARGUMENT` (not truncation) is the answer past it.
 */
export const MCP_CORRELATION_ID_MAX_LENGTH = 128;

/**
 * The accepted characters: ASCII letters, digits, and `_ . : -`. See the module
 * comment for why exactly this set; the short version is "the union of the
 * characters every identifier a caller would paste in already uses, minus
 * everything that would need escaping".
 */
export const MCP_CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * The declared `correlationId` field. Every accepting tool splices
 * `correlationId: MCP_CORRELATION_ID_INPUT_FIELD.optional()` into its own
 * `inputSchema`, so the length, the charset and the field's presence on
 * `tools/list` are one declaration rather than one per tool. A value that breaks
 * it is an `INVALID_ARGUMENT` naming `correlationId`; an absent one leaves the
 * tool's behaviour byte-for-byte as it was before this field existed.
 */
export const MCP_CORRELATION_ID_INPUT_FIELD = z
  .string()
  .min(MCP_CORRELATION_ID_MIN_LENGTH)
  .max(MCP_CORRELATION_ID_MAX_LENGTH)
  .regex(MCP_CORRELATION_ID_PATTERN);

/**
 * The sentence every accepting tool appends to its description, so a caller
 * reads the contract off `tools/list` rather than inferring it: the label is
 * opaque, it comes back on the audit record, and the server does not interpret
 * it — which is the one thing a caller of a field named "correlationId" could
 * otherwise reasonably get wrong (by expecting it to drive something).
 */
export const MCP_CORRELATION_ID_DESCRIPTION =
  'An optional opaque correlation label: it is only stored on the run and echoed on the audit record, ' +
  'never interpreted or advanced by the server.';

/**
 * Reads a correlation label off an argument object. Answers the label when it is
 * a string inside the declared contract, and `null` for anything else — absent,
 * another type, too long, or outside the charset — without throwing (see the
 * module comment: the declared schema is the enforcement point, this is the
 * reading).
 *
 * Consumers: the two run-starting builders (`mcp-session-send.ts`,
 * `mcp-session-lifecycle.ts`), the audit wrapper and the two filters. All six
 * treat `null` as "there is no label to store or to narrow by".
 */
export function readCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length < MCP_CORRELATION_ID_MIN_LENGTH || value.length > MCP_CORRELATION_ID_MAX_LENGTH) {
    return null;
  }
  return MCP_CORRELATION_ID_PATTERN.test(value) ? value : null;
}
