/**
 * The MCP tool argument-schema contract.
 *
 * A registration declares either a Zod raw shape (`{ session: z.string() }`) or
 * an ALREADY-BUILT object schema. The second arm exists so a registration can
 * express an object-level constraint a raw shape cannot — e.g. a mutual
 * exclusion (`z.object({…}).superRefine(…)`) or a `minimum` / `maximum` on a
 * field.
 *
 * Re-homed from `server/modules/mcp-gateway/mcp-gateway.audit.ts` (AC-288) so a
 * domain tool package can type its declared schema without importing
 * `server/modules/**` (proposal rule R2). The audited wrapper still normalizes
 * and enforces it; this file only states the type.
 *
 * Consumers: `mcp-gateway.audit.ts` (re-exported through the gateway barrel),
 * the transport, every tool module whose registration declares a shape, and the
 * contract's `ToolDefinition`.
 */

import type { z } from 'zod';

/**
 * A tool's declared argument schema: a Zod raw shape, or a built schema.
 *
 * Both arms are ONE declaration: the audited wrapper hands the SAME schema to
 * the SDK for `tools/list` and validates against it, so the advertised schema
 * and the validation truth cannot drift.
 */
export type McpToolInputSchema = z.ZodRawShape | z.ZodType;
