/**
 * The architecture module's HTTP face (AC-418, ADR-005 decisions 1 and 2).
 *
 * `POST /api/architecture/graph` takes `{ projectId, sessionId }` plus the two
 * optional generation knobs and answers the service's reading unchanged:
 * `{ graph: { file, entity }, mmd: { file, entity }, stats, provenance }`.
 * `graph` is the render-ready neighbourhood JSON (nodes carry `distance`, edges
 * carry `relationType`); `mmd` stays as the document export path. Nothing here
 * reads a file, expands a graph or knows what `.archguard` is — the route parses
 * transport input, calls one service method, and lets the process error
 * middleware translate the service's `AppError`s (404 `PROJECT_NOT_FOUND` /
 * `ARCHGUARD_CACHE_NOT_FOUND`, 400 `INVALID_REQUEST`).
 *
 * Consumers: `server/modules/architecture/module.js` (production composition)
 * and `server/modules/architecture/tests/architecture-routes.test.js`.
 */
import express, { type Router } from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { ArchitectureGraphInput, ArchitectureService } from './service.js';

function invalidRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

/** Read a required non-empty string field from the request body. */
function requireStringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest(`"${name}" must be a non-empty string`);
  }
  return value;
}

/** Read an optional non-negative integer field from the request body. */
function optionalCountField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidRequest(`"${name}" must be a non-negative integer`);
  }
  return value;
}

/**
 * Parse and validate the request body. `hops`/`maxNodes` are optional: the
 * service supplies the ADR defaults, and an explicit zero is legal (a zero-hop
 * graph is the seeds themselves; a zero budget is an empty graph).
 */
function readGraphInput(body: unknown): ArchitectureGraphInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  return {
    projectId: requireStringField(record, 'projectId'),
    sessionId: requireStringField(record, 'sessionId'),
    hops: optionalCountField(record, 'hops'),
    maxNodes: optionalCountField(record, 'maxNodes'),
  };
}

/**
 * Build the router over one service instance.
 *
 * Consumers: `server/modules/architecture/module.js` only; the module's barrel
 * exposes the composed module, not this factory.
 */
export function createArchitectureRoutes(service: ArchitectureService): Router {
  const router = express.Router();

  router.post(
    '/graph',
    asyncHandler(async (request, response) => {
      const input = readGraphInput(request.body);
      const result = await service.readGraph(input);
      response.json(result);
    }),
  );

  return router;
}
