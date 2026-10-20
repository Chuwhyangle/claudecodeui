/**
 * MCP tool-call auditing (AC-244).
 *
 * Every tool invocation writes EXACTLY one row to `mcp_audit_log`, whatever its
 * result: `ok`, `denied` (the token lacks a required scope, so the handler never
 * runs) or `error` (the handler threw). The arguments are reduced to a digest
 * before they reach the database — session and project ids are kept verbatim,
 * every other string is replaced by its length and first 40 characters — so the
 * full text of a tool call can never be read back out of the log. AC-286: a
 * `denied` row also carries the scopes the caller was MISSING
 * (`denied_scopes`), whether the refusal came from the generic check here or
 * from a handler's own scope check throwing {@link McpScopeDeniedError}.
 *
 * AC-337: the caller's opaque `correlationId` label — when the tool declares one
 * and the call carries a usable value — is read HERE, once per call, from the raw
 * arguments, and written to the row's `correlation_id` column. The write/read
 * split is the tool's own `readOnlyHint` annotation, the same one AC-303's
 * write-notification seam already classifies by, so a READ tool's identically
 * named argument stays what it is (a filter over other rows) and never lands in
 * its own audit row. All five branches below — no principal, missing scope,
 * invalid argument, ok and throw — carry the same reading, so a refused or failed
 * call is as correlatable as a successful one.
 *
 * The retention sweep and the audit dispatch are both injectable: the clock and
 * the interval scheduler are seams, so a criterion can plant an old row or
 * capture the daily callback without waiting on wall time. The module holds no
 * module-level timer or cache, so an injected seam is never shadowed by state
 * left over from another mount.
 *
 * Consumers: `mcp-gateway.transport.ts` registers tools through
 * {@link withMcpAudit} and starts retention at mount time; this module's
 * criterion drives every export directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { mcpAuditLogDb } from '@/modules/database/index.js';
import type { McpToolInputSchema } from '@/shared/mcp-contract/index.js';

import { readCorrelationId } from './mcp-correlation-id.js';
import {
  insufficientScopeResult,
  invalidArgumentFields,
  MCP_ERROR_CODES,
  MCP_ERROR_ENVELOPE_SHAPE,
  McpScopeDeniedError,
  mcpErrorResult,
  toMcpErrorResult,
  unknownToolResult,
} from './mcp-error-envelope.js';
import type { McpInvalidField } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpWriteNotification } from './mcp-write-notification.js';

/** The three results a tool call can leave in the audit log. */
export type McpAuditOutcome = 'ok' | 'denied' | 'error';

/** How many characters of a free-text argument survive into the digest. */
const PREVIEW_LENGTH = 40;

/**
 * Argument keys whose value is an identifier and is therefore kept verbatim.
 * Covers the SPEC's tool table (`{ session }`, `{ project }`) and their variants;
 * a later task that introduces another id key extends this set.
 */
const ID_ARGUMENT_KEYS: ReadonlySet<string> = new Set(['session', 'sessionId', 'project', 'projectId']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Retention window, in days, matching the SPEC. */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Reduces one argument value. An identifier key keeps its value untouched; a
 * string becomes `{ length, preview }`; arrays and objects recurse; every other
 * primitive (number, boolean, null) is returned as-is. `key` is `null` for
 * array elements, which have no key of their own.
 */
function summarizeValue(value: unknown, key: string | null): unknown {
  if (key !== null && ID_ARGUMENT_KEYS.has(key)) {
    return value;
  }
  if (typeof value === 'string') {
    // Only the length and the first PREVIEW_LENGTH characters — no ellipsis, no
    // tail — so nothing past the preview can ever be reconstructed.
    return { length: value.length, preview: value.slice(0, PREVIEW_LENGTH) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeValue(item, null));
  }
  if (typeof value === 'object' && value !== null) {
    const summarized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      summarized[entryKey] = summarizeValue(entryValue, entryKey);
    }
    return summarized;
  }
  return value;
}

/**
 * The argument digest written to `mcp_audit_log.args_digest`. Pure: it reads no
 * clock and touches no database. Consumers: {@link recordMcpToolCall} and this
 * module's criterion, which asserts the full free text appears in neither the
 * digest nor any other column of the row.
 */
export function summarizeToolArgs(args: unknown): string {
  const digest = JSON.stringify(summarizeValue(args, null));
  return digest === undefined ? 'null' : digest;
}

/** What {@link recordMcpToolCall} needs to write its one row. */
export type McpToolCallReading = {
  /** The invoking token's row id, or null when no token could be attributed. */
  tokenId: number | null;
  /** The OAuth client id, always null for a personal access token. */
  clientId: string | null;
  tool: string;
  outcome: McpAuditOutcome;
  /** Non-negative elapsed time of the dispatch, in milliseconds. */
  durationMs: number;
  args: unknown;
  /**
   * AC-286: for a `denied` row, the scopes the caller's token was missing —
   * persisted so an operator can read WHICH scope a refusal was about without
   * replaying the request. Absent (or null) for every other outcome, including
   * a denial with no scope reading (an unauthenticated call).
   */
  deniedScopes?: readonly string[] | null;
  /**
   * gap-mcp-usage-stats: the machine error code this call ended on, or null on
   * `ok`. A scope denial stamps `INSUFFICIENT_SCOPE`, a declared-schema failure
   * stamps `INVALID_ARGUMENT`, and a thrown handler stamps the code its error
   * envelope carries. Consumers: `mcp_usage_stats` grouping by `error_code`.
   */
  errorCode?: string | null;
  /**
   * gap-mcp-usage-stats: the UTF-8 byte length of the serialized success
   * payload — `structuredContent` when the tool declares an output schema, the
   * text content otherwise — or null on every failure, which returns no tool
   * payload of its own. Consumers: `mcp_usage_stats`'s per-group byte quantiles.
   */
  responseBytes?: number | null;
  /**
   * AC-337: the opaque correlation label the caller attached to this call, or
   * null. Written only for a tool that CAN change state (`readOnlyHint: false`),
   * because the label is a property of a call the caller is trying to follow as
   * work — a read tool's identically-named argument is a FILTER, not a label it
   * is stamping, and stamping it would make `mcp_usage_stats`'s own
   * `correlationId` filter write rows that then match it.
   *
   * The value has already been read through `readCorrelationId`, so an absent,
   * too-long or illegal label arrives as null and the column stays null — the
   * audit row never stores a value the declared schema would have refused.
   */
  correlationId?: string | null;
};

/**
 * Writes the single audit row for one tool call and returns its id. This is the
 * only writer of `mcp_audit_log`: the ok, denied and error paths of
 * {@link withMcpAudit} all funnel through here, which is what makes "exactly one
 * row per call" a property of one function rather than of three branches.
 */
export function recordMcpToolCall(reading: McpToolCallReading): number {
  return mcpAuditLogDb.insert({
    tokenId: reading.tokenId,
    clientId: reading.clientId,
    tool: reading.tool,
    argsDigest: summarizeToolArgs(reading.args),
    outcome: reading.outcome,
    durationMs: reading.durationMs,
    deniedScopes: reading.deniedScopes ?? null,
    errorCode: reading.errorCode ?? null,
    responseBytes: reading.responseBytes ?? null,
    correlationId: reading.correlationId ?? null,
  });
}

/** The seams {@link startMcpAuditRetention} reads, all injectable for the criterion. */
export type McpAuditRetentionOptions = {
  /** Clock, default `() => new Date()`. */
  now?: () => Date;
  /** Scheduler, default `globalThis.setInterval`. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Retention window in days, default 90. */
  retentionDays?: number;
};

/**
 * Starts the audit-log retention sweep: one pass immediately (startup) and one
 * every 24 hours thereafter. Returns the sweep so a caller can invoke it
 * directly; the interval handle itself belongs to the injected scheduler.
 *
 * The sweep deletes rows strictly older than `retentionDays`, so a row exactly
 * on the boundary is kept. Consumers: `mountMcpGateway` (production startup) and
 * this module's criterion, which injects a fixed clock and a capturing
 * scheduler to observe both the immediate pass and the 24-hour cadence.
 */
export function startMcpAuditRetention(options: McpAuditRetentionOptions = {}): { prune: () => number } {
  const now = options.now ?? (() => new Date());
  const schedule = options.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const prune = (): number =>
    mcpAuditLogDb.deleteOlderThan(new Date(now().getTime() - retentionDays * MS_PER_DAY).toISOString());

  // The startup pass runs before the interval is registered, so a caller that
  // captures the registration still observes the immediate sweep.
  prune();
  schedule(prune, MS_PER_DAY);

  return { prune };
}

/**
 * A tool's declared argument schema: either a Zod raw shape (`{ session:
 * z.string() }`) or an ALREADY-BUILT object schema. The second arm exists so a
 * registration can express an object-level constraint a raw shape cannot — an
 * AC-288 mutual exclusion (`z.object({…}).superRefine(…)`) or a `minimum` /
 * `maximum` on a field. Both arms are one declaration: {@link withMcpAudit}
 * hands the SAME schema to the SDK for `tools/list` and validates against it, so
 * the advertised schema and the validation truth cannot drift.
 *
 * The type itself lives in the contract (`server/shared/mcp-contract/schemas.ts`,
 * proposal stage 1) and is re-exported here so the gateway barrel keeps its
 * public surface unchanged.
 */
export type { McpToolInputSchema };

/**
 * Whether a declared schema is already a built Zod schema rather than a raw
 * shape. Zod v4 stamps every schema instance with `_zod`; a raw shape is a plain
 * object whose values are schemas and has none.
 */
function isZodSchemaInstance(value: McpToolInputSchema): value is z.ZodType {
  return '_zod' in value;
}

/**
 * Normalizes a registration's declared schema into the one Zod schema the
 * wrapper validates against (a raw shape is wrapped; a built schema is used as
 * it is). Consumers: {@link withMcpAudit}, which normalizes once per
 * registration.
 */
function toDeclaredSchema(input: McpToolInputSchema): z.ZodType {
  return isZodSchemaInstance(input) ? input : z.object(input);
}

/**
 * Returns an output shape with every top-level field made optional
 * (gap-mcp-outputschema-drift-overview-and-error-envelope).
 *
 * A tool's declared output schema is written for its SUCCESS payload, where a
 * field like `running` is always present. But the SAME schema also validates an
 * `isError` result, whose `structuredContent` is the error envelope and carries
 * none of the tool's own fields — and JSON-schema `required` is enforced for
 * that result too. Making the envelope's four fields optional is therefore NOT
 * enough on its own: a success field left required would still be demanded of
 * every failure. Optionalizing the top level empties the emitted `required`
 * array, so both shapes validate; nested objects keep their own `required`,
 * which is correct because a `running` row that IS present must still be whole.
 *
 * Consumers: {@link withMcpAudit}'s single registration line, where it is
 * applied to the tool's declared shape BEFORE {@link MCP_ERROR_ENVELOPE_SHAPE}
 * is spliced in.
 */
function toOptionalOutputShape(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    // A raw shape's values are typed as the loose `$ZodType`; width it to the
    // classic `ZodType` so `.optional()` is in the type (it is at runtime).
    Object.entries(shape).map(([key, schema]) => [key, (schema as z.ZodType).optional()]),
  );
}

/** A tool's audited definition, as passed to {@link withMcpAudit}. */
export type McpToolRegistration = {
  name: string;
  /**
   * The client-facing description, when the tool has one. Absent keeps the
   * AC-244 shape: a registration that names only its scope and handler is still
   * a complete one, and the tools that criterion registers must keep answering
   * exactly as they did.
   */
  description?: string;
  /**
   * The tool's argument schema, as a {@link McpToolInputSchema}. Absent means
   * "accept any argument object" — what AC-244's tools rely on: the audit digest
   * must see the caller's full argument object, so a fixed shape would strip
   * unknown keys before the handler ever ran.
   *
   * When present, the SAME schema is
   *  - validated against, here in the wrapper, BEFORE the handler runs, with a
   *    miss answered as an `INVALID_ARGUMENT` envelope (AC-284/AC-288); and
   *  - handed to the SDK, so `tools/list` advertises exactly what is enforced —
   *    a `minimum`/`maximum` or an object-level `.superRefine` reaches the wire
   *    rather than living only in the validation branch (AC-288 (f)).
   */
  inputSchema?: McpToolInputSchema;
  /**
   * The tool's result schema. When present the handler's return value is also
   * emitted as `structuredContent` — the SDK refuses a non-error result from a
   * tool that declares an output schema without one.
   */
  outputSchema?: z.ZodRawShape;
  /**
   * The declaration hints (`readOnlyHint` / `destructiveHint` /
   * `idempotentHint` / `openWorldHint`) forwarded verbatim to
   * `registerTool`. Optional, and absent keeps the AC-244 shape exactly: those
   * criteria register tools with no annotations and must keep answering as they
   * did. The transport's one seam attaches the gateway's table
   * (`readMcpToolAnnotations`) to every production tool. Annotations carry NO
   * authorization weight — the audit wrapper still decides `denied`/`ok`/`error`
   * from `requiredScopes` alone (AC6).
   */
  annotations?: ToolAnnotations;
  /**
   * Structured tool metadata forwarded verbatim to `registerTool` as `_meta`,
   * and therefore carried on `tools/list` (AC-285). The transport's one seam uses
   * it to publish each tool's declared error-code set
   * (`{ 'cloudcli/errorCodes': [...] }`) so a real client reads the declaration
   * off the wire rather than out of a test-local list. Metadata only — like
   * `annotations`, it carries NO authorization weight, and absent keeps the
   * AC-244 shape exactly.
   */
  meta?: Record<string, unknown>;
  /** Every scope the caller's token must carry; a missing one denies the call. */
  requiredScopes: readonly string[];
  handler: (args: unknown, ctx: { principal: McpPrincipal }) => unknown;
};

/**
 * Installs one or more audited tools on the per-request `McpServer`, given the
 * principal of the request being served (or null when the server was built
 * without one). {@link withMcpAudit}'s return and the transport's `registerTools`
 * seam share this shape.
 */
export type McpToolRegistrar = (server: McpServer, principal: McpPrincipal | null) => void;

/**
 * One audited tool's registration function, as returned by {@link withMcpAudit}.
 * Consumers: `mcp-gateway.transport.ts` (through the `registerTools` seam) and
 * AC-245+'s real tool registrations, which reuse this wrapper.
 */
export type McpToolHandler = McpToolRegistrar;

/** Renders an arbitrary handler result as MCP text content. */
function toTextContent(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

/**
 * Renders a handler result as `structuredContent`, which the SDK validates
 * against the declared output schema. A non-object result is wrapped rather
 * than rejected, so a tool whose handler returns a bare string still produces a
 * shape an output schema can describe.
 */
function toStructuredContent(result: unknown): Record<string, unknown> {
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { value: result ?? null };
}

/** The most characters an envelope `message` may carry (AC-288 (c)). */
const MAX_ENVELOPE_MESSAGE_LENGTH = 300;

/** How many field paths the sentence names before it summarizes the remainder. */
const MAX_NAMED_FIELDS = 8;

/**
 * The one-sentence `message` an `INVALID_ARGUMENT` envelope carries: the tool
 * and the offending paths, and NOTHING else — never zod's issue dump, never the
 * SDK's `Input validation error: …` prose. Bounded twice, so it cannot grow
 * without limit: at most {@link MAX_NAMED_FIELDS} paths are named (the rest are
 * counted), and the whole sentence is clamped to
 * {@link MAX_ENVELOPE_MESSAGE_LENGTH} characters. The per-field detail a caller
 * branches on lives in `details.fields`, not here.
 */
function invalidArgumentMessage(tool: string, fields: readonly McpInvalidField[]): string {
  const named = fields
    .slice(0, MAX_NAMED_FIELDS)
    .map((field) => (field.path.length > 0 ? field.path : '(root)'))
    .join(', ');
  const omitted = fields.length > MAX_NAMED_FIELDS ? ` (+${fields.length - MAX_NAMED_FIELDS} more)` : '';
  const sentence = `Invalid arguments for tool "${tool}": ${named}${omitted}.`;
  return sentence.length <= MAX_ENVELOPE_MESSAGE_LENGTH
    ? sentence
    : `${sentence.slice(0, MAX_ENVELOPE_MESSAGE_LENGTH - 3)}...`;
}

/**
 * Turns a declared-schema validation failure into the `INVALID_ARGUMENT`
 * envelope: a short English sentence plus the per-field detail AC-288 specifies
 * ({@link invalidArgumentFields}). `args` is the caller's original argument
 * object, which is what tells a missing argument from a wrong-typed one.
 *
 * Consumers: {@link withMcpAudit}'s call path, which is the only place a tool's
 * declared `inputSchema` is validated, and this module's criterion through it.
 */
function invalidArgumentResult(tool: string, error: z.ZodError, args: unknown): CallToolResult {
  const fields = invalidArgumentFields(error, args);
  return mcpErrorResult(
    MCP_ERROR_CODES.INVALID_ARGUMENT,
    invalidArgumentMessage(tool, fields),
    false,
    { fields },
  );
}

/**
 * Wraps a tool so every call is audited exactly once, then returns the
 * registration function that installs it. The scope check happens BEFORE the
 * handler: a token missing a required scope is recorded as `denied` and the
 * handler never runs. A handler that throws is recorded as `error` and turned
 * into an `isError` result rather than being allowed to crash the process; a
 * normal return is recorded as `ok`. All three paths write through the single
 * {@link recordMcpToolCall}.
 *
 * The declared `inputSchema` — a raw shape, or a built object schema carrying a
 * constraint a raw shape cannot — is the ONE truth for two things (AC-288 (f)):
 * it is handed to the SDK, so `tools/list` advertises exactly what is enforced,
 * and it is parsed here, so a missing, wrong-typed, out-of-range or
 * mutually-exclusive argument becomes an `INVALID_ARGUMENT` envelope rather than
 * the SDK's text-only protocol error. A registration that declares no shape is
 * handed the permissive `z.record` — what AC-244's tools rely on, because the
 * audit digest must see the caller's full argument object. A registration that
 * declares an output schema gets its result emitted as `structuredContent`
 * alongside the text, because the SDK refuses a non-error result that has none.
 *
 * Every failure branch (no principal, missing scope, invalid argument, handler
 * throw) returns through {@link mcpErrorResult} / {@link toMcpErrorResult}, so
 * the wire carries `{ isError: true, structuredContent: { code, message,
 * retryable, details? } }` in every case. The success branch is untouched.
 *
 * A registration may also declare `annotations` (AC1–AC7) and `meta` (AC-285);
 * both are forwarded to `registerTool` verbatim and appear on `tools/list`, but
 * they are metadata only — the `denied`/`ok`/`error` decision below is made from
 * `requiredScopes` alone, so a declaration can never widen or narrow what a
 * token may call.
 *
 * An optional second argument threads AC-303's write-notification seam. It is
 * called ONLY from the `ok` branch, AFTER the audit row is written, and is wrapped
 * in its own try/catch: a throwing notifier must not change the tool call's
 * result nor turn the `ok` row into an `error` one. The seam is handed every
 * registration (read and write alike) and classifies each call itself — a
 * read-only tool returns without notifying — so the write/read split stays in
 * one place. Omitting the argument keeps AC-244's behaviour byte-for-byte.
 */
export function withMcpAudit(
  registration: McpToolRegistration,
  writeNotifications?: McpWriteNotification,
): McpToolHandler {
  // Built once per registration, not per call: the declared schema is fixed when
  // the tool is installed. The SAME schema is advertised (handed to the SDK) and
  // enforced (parsed by the runner), so `tools/list` and validation cannot drift.
  const declaredSchema =
    registration.inputSchema === undefined ? null : toDeclaredSchema(registration.inputSchema);
  return (server, principal) => {
    const run = createAuditedRunner(registration, principal, declaredSchema, writeNotifications);
    server.registerTool(
      registration.name,
      {
        ...(registration.description === undefined ? {} : { description: registration.description }),
        // The declared schema is advertised verbatim, so a real client reads the
        // SAME constraints the runner enforces: a `minimum` / `maximum`, an enum,
        // or an object-level `.superRefine` reaches `tools/list` rather than
        // living only in the validation branch (AC-288 (f)). A registration that
        // declares no shape keeps AC-244's permissive record, because the audit
        // digest must see the caller's full argument object.
        inputSchema: declaredSchema ?? z.record(z.string(), z.unknown()),
        // The declared output schema is spliced ONCE here, in the audited
        // wrapper: the tool's own success fields are optionalized (so an error
        // envelope need not carry them) and the four error-envelope fields are
        // merged in (so an error envelope is expressible at all). Without this a
        // warm client validates the `isError` result against the success schema
        // and answers `-32602` instead of the gateway's real code
        // (gap-mcp-outputschema-drift-overview-and-error-envelope).
        ...(registration.outputSchema === undefined
          ? {}
          : { outputSchema: { ...toOptionalOutputShape(registration.outputSchema), ...MCP_ERROR_ENVELOPE_SHAPE } }),
        // Metadata only: forwarded to the SDK so it appears verbatim on
        // `tools/list`. It changes nothing about the scope check below.
        ...(registration.annotations === undefined ? {} : { annotations: registration.annotations }),
        // AC-285: the tool's declared error-code set, forwarded as `_meta` so a
        // real client reads the declaration off `tools/list`. Metadata only; it
        // changes nothing about the scope check below.
        ...(registration.meta === undefined ? {} : { _meta: registration.meta }),
      },
      // The SDK infers the callback's `args` from the (unioned) declared schema
      // as `unknown`; the audited runner takes the plain record the dispatcher
      // and the audit digest both use, so the boundary narrows here.
      (args: unknown) => run((args ?? {}) as Record<string, unknown>),
    );
    // AC-288: the server's dispatcher — installed once every registration has
    // run — reads this entry to reach THIS runner, so the audit row, the scope
    // check, the declared-schema validation and the envelope all live on one
    // path rather than in a second copy.
    registryFor(server).set(registration.name, run);
  };
}

/**
 * Builds one tool's audited runner: the single function that records the audit
 * row, decides `denied` / `ok` / `error`, validates the caller's arguments
 * against the tool's declared schema, and renders either the handler's result or
 * the one failure envelope. {@link withMcpAudit} is its only consumer.
 *
 * It is a factory rather than an inline callback so the SAME function object can
 * be both handed to `registerTool` and stored in the server's registry — one
 * call path, two references, no second copy of the rules.
 */
function createAuditedRunner(
  registration: McpToolRegistration,
  principal: McpPrincipal | null,
  declaredSchema: z.ZodType | null,
  writeNotifications: McpWriteNotification | undefined,
): McpAuditedRunner {
  return async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const startedAt = Date.now();
    const elapsedMs = (): number => Math.max(0, Date.now() - startedAt);
    // AC-337: the one reading of the caller's correlation label, taken from the
    // RAW arguments (before the declared schema strips unknown keys) and only for
    // a tool that can change state. A read tool writes null here — its
    // `correlationId` argument is a filter it is applying, not a label it is
    // stamping — and an absent or unusable value reads null for a write tool too,
    // so the column never carries something the schema would have refused.
    const correlationId =
      registration.annotations?.readOnlyHint === false ? readCorrelationId(args.correlationId) : null;

    // No principal means no authenticated caller (unreachable behind the auth
    // middleware, but a denial is the safe reading rather than an ok).
    if (principal === null) {
      recordMcpToolCall({
        tokenId: null,
        clientId: null,
        tool: registration.name,
        outcome: 'denied',
        durationMs: elapsedMs(),
        args,
        errorCode: MCP_ERROR_CODES.INSUFFICIENT_SCOPE.code,
        responseBytes: null,
        correlationId,
      });
      return mcpErrorResult(
        MCP_ERROR_CODES.INSUFFICIENT_SCOPE,
        'Authentication is required to call this tool.',
      );
    }

    // AC-286: name the scopes the caller is MISSING (declared minus held), not
    // the tool's whole declared set — that is what the envelope and the denied
    // audit row both carry, so a caller can re-authorize with exactly these.
    const missingScopes = registration.requiredScopes.filter((scope) => !principal.scopes.includes(scope));
    if (missingScopes.length > 0) {
      recordMcpToolCall({
        tokenId: principal.tokenId,
        clientId: principal.clientId,
        tool: registration.name,
        outcome: 'denied',
        durationMs: elapsedMs(),
        args,
        deniedScopes: missingScopes,
        errorCode: MCP_ERROR_CODES.INSUFFICIENT_SCOPE.code,
        responseBytes: null,
        correlationId,
      });
      return insufficientScopeResult(missingScopes, registration.name);
    }

    // The declared schema is validated HERE, so a missing, wrong-typed,
    // out-of-range or mutually-exclusive argument lands in the one envelope
    // rather than the SDK's text-only protocol error.
    let handlerArgs = args;
    if (declaredSchema !== null) {
      const parsed = declaredSchema.safeParse(args);
      if (!parsed.success) {
        recordMcpToolCall({
          tokenId: principal.tokenId,
          clientId: principal.clientId,
          tool: registration.name,
          outcome: 'error',
          durationMs: elapsedMs(),
          args,
          errorCode: MCP_ERROR_CODES.INVALID_ARGUMENT.code,
          responseBytes: null,
          correlationId,
        });
        return invalidArgumentResult(registration.name, parsed.error, args);
      }
      handlerArgs = parsed.data as Record<string, unknown>;
    }

    try {
      const result = await registration.handler(handlerArgs, { principal });
      // Render once, here, so the audit row's byte count is the payload the
      // caller actually receives: `structuredContent` when the tool declares an
      // output schema, the text content otherwise — exactly what the return
      // below emits. gap-mcp-usage-stats reads this column back as a size
      // reading; a failure row carries null, since it returns no tool payload.
      const text = toTextContent(result);
      const structuredContent = registration.outputSchema === undefined ? undefined : toStructuredContent(result);
      recordMcpToolCall({
        tokenId: principal.tokenId,
        clientId: principal.clientId,
        tool: registration.name,
        outcome: 'ok',
        durationMs: elapsedMs(),
        args,
        errorCode: null,
        responseBytes: Buffer.byteLength(JSON.stringify(structuredContent ?? text), 'utf8'),
        correlationId,
      });
      // AC-303: notify the token's owner of a SUCCESSFUL call only. Its own
      // try/catch keeps a throwing notifier from reaching the outer catch, which
      // would otherwise write an `error` row and return `isError` for a call that
      // actually succeeded.
      if (writeNotifications !== undefined) {
        try {
          writeNotifications.notify({ principal, tool: registration.name, args });
        } catch {
          // Swallowed by design — the audit row above is already `ok` and the
          // caller still receives the handler's result.
        }
      }
      return structuredContent === undefined
        ? { content: [{ type: 'text', text }] }
        : { content: [{ type: 'text', text }], structuredContent };
    } catch (error) {
      // The one envelope this failure returns is built ONCE and read twice — its
      // code is persisted to the audit row and the same envelope is returned, so
      // the row and the wire can never disagree.
      const envelope = toMcpErrorResult(error);
      // AC-286: a handler that owns its own scope check throws
      // McpScopeDeniedError; that is a DENIAL, not an error, so it records the
      // missing scopes and reads back `denied` — the same outcome the generic
      // scope branch above writes. Every other throw keeps its `error` reading.
      const scopeDenied = error instanceof McpScopeDeniedError;
      recordMcpToolCall({
        tokenId: principal.tokenId,
        clientId: principal.clientId,
        tool: registration.name,
        outcome: scopeDenied ? 'denied' : 'error',
        durationMs: elapsedMs(),
        args,
        deniedScopes: scopeDenied ? error.requiredScopes : null,
        errorCode: (envelope.structuredContent as { code?: string } | undefined)?.code ?? null,
        responseBytes: null,
        correlationId,
      });
      return envelope;
    }
  };
}

// --------------------------- the tools/call dispatcher (AC-288) ---------------------------

/** One registered tool's audited call path, as the server's dispatcher invokes it. */
type McpAuditedRunner = (args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * The audited runner of every tool {@link withMcpAudit} installed on a given
 * per-request `McpServer`. Keyed by the server (a WeakMap, so a finished
 * request's map is collected with it) and then by tool name — so two mounts
 * serving two requests, or two token principals, never read each other's tools.
 */
const auditedRunners = new WeakMap<McpServer, Map<string, McpAuditedRunner>>();

/** The (created-on-demand) runner map for one server. Consumers: {@link withMcpAudit} and {@link installMcpCallDispatcher}. */
function registryFor(server: McpServer): Map<string, McpAuditedRunner> {
  let runners = auditedRunners.get(server);
  if (runners === undefined) {
    runners = new Map();
    auditedRunners.set(server, runners);
  }
  return runners;
}

/**
 * Replaces this server's `tools/call` handler with the gateway's own dispatcher
 * (AC-288). It must be called AFTER every tool has been registered: it is a
 * wholesale replacement of the SDK's handler, not a wrapper around it.
 *
 * Why the SDK's handler cannot stay: the wrapper registers each tool's REAL
 * declared schema with the SDK so `tools/list` advertises it (AC-288 (f)), and
 * the SDK's handler would then reject a bad argument with its own text-only
 * `Input validation error: …` before the audited runner ever ran — exactly the
 * residue AC-288 removes. Replacing the handler makes the runner's
 * `INVALID_ARGUMENT` envelope the only validation outcome, and lets an
 * unregistered name answer `UNKNOWN_TOOL` instead of the SDK's `Tool X not
 * found` sentence.
 *
 * A registered name runs through its audited runner — the SAME function the SDK
 * handler used to invoke, so the audit row, the scope refusal, the
 * declared-schema validation and the success rendering are unchanged. An
 * unregistered name returns {@link unknownToolResult} and writes NO audit row:
 * it is not a call to any tool, so there is no tool call to record.
 *
 * A server with no audited tool (AC-240's tools-less mount, or a seam that
 * registers nothing) is left untouched, so `tools/call` keeps whatever the mount
 * installed.
 *
 * Consumers: `mcp-gateway.transport.ts`'s `createMcpServer`, once per request,
 * after the injected / read / write / resident tools are all installed.
 */
export function installMcpCallDispatcher(server: McpServer): void {
  const runners = auditedRunners.get(server);
  if (runners === undefined || runners.size === 0) {
    return;
  }
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const runner = runners.get(request.params.name);
    if (runner === undefined) {
      return unknownToolResult(request.params.name);
    }
    return runner(request.params.arguments ?? {});
  });
}
