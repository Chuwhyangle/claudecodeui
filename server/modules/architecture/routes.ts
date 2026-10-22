/**
 * The architecture module's HTTP face (AC-418, ADR-005 decisions 1 and 2).
 *
 * `POST /api/architecture/graph` takes `{ projectId, sessionId }` plus the two
 * optional generation knobs and answers the service's reading unchanged:
 * `{ graph: { file, entity }, mmd: { file, entity }, stats, provenance }`.
 * `POST /api/architecture/mentions` takes `{ projectId, sessionId, entityIds?,
 * edge?, includeToolResults?, limit? }` and answers the on-demand provenance
 * reading.
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

import { ENTITY_KINDS, RELATION_TYPES, type EntityKind, type RelationType } from './generator.js';
import type {
  ArchitectureGraphInput,
  ArchitectureMentionsInput,
  ArchitectureSearchInput,
  ArchitectureService,
} from './service.js';

/** Manual pins are bounded at 200 (the curation store's own cap). */
export const MAX_EXTRA_SEEDS = 200;

/** Manual removals are bounded at 500 (the curation store's own cap). */
export const MAX_EXCLUDE_IDS = 500;

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
 * Read an optional array of vocabulary values (the element/relation filters).
 *
 * An ABSENT field is "no filter" and is the only way to ask for the old
 * reading. An EMPTY array is legal and means "show none of this axis" (every
 * non-exempt entity, or every edge, is hidden). A value outside the vocabulary
 * is a client bug, not something to silently drop: it answers 400 naming the
 * field, so a typo cannot quietly produce a narrower graph than was asked for.
 */
function optionalVocabularyField<T extends string>(
  body: Record<string, unknown>,
  name: string,
  vocabulary: readonly T[],
): readonly T[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalidRequest(`"${name}" must be an array of strings`);
  }
  const unknown = (value as string[]).find((entry) => !(vocabulary as readonly string[]).includes(entry));
  if (unknown !== undefined) {
    throw invalidRequest(
      `"${name}" contains an unknown value "${unknown}" (expected one of ${vocabulary.join(', ')})`,
    );
  }
  return value as T[];
}

/**
 * Read an optional array of non-empty entity ids with a hard cap.
 *
 * An ABSENT field is "no manual curation" and keeps the old reading. An empty
 * array is legal (the caller says "I have no pins") and is not the same thing
 * as an absent field: it makes the response carry `stats.curation`. Over the
 * cap is a 400 rather than a silent truncation — dropping pins would draw a
 * graph the client did not ask for.
 */
function optionalIdListField(
  body: Record<string, unknown>,
  name: string,
  cap: number,
): readonly string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw invalidRequest(`"${name}" must be an array of non-empty strings`);
  }
  if (value.length > cap) {
    throw invalidRequest(`"${name}" carries ${value.length} ids; the maximum is ${cap}`);
  }
  return value as string[];
}

/**
 * Parse and validate the request body. `hops`/`maxNodes` are optional: the
 * service supplies the ADR defaults, and an explicit zero is legal (a zero-hop
 * graph is the seeds themselves; a zero budget is an empty graph). `kinds` and
 * `relations` are the optional element/relation filters; leaving both out is
 * the old, unfiltered reading.
 */
function readGraphInput(body: unknown): ArchitectureGraphInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const kinds = optionalVocabularyField<EntityKind>(record, 'kinds', ENTITY_KINDS);
  const relations = optionalVocabularyField<RelationType>(record, 'relations', RELATION_TYPES);
  const extraSeeds = optionalIdListField(record, 'extraSeeds', MAX_EXTRA_SEEDS);
  const excludeIds = optionalIdListField(record, 'excludeIds', MAX_EXCLUDE_IDS);
  return {
    projectId: requireStringField(record, 'projectId'),
    sessionId: requireStringField(record, 'sessionId'),
    hops: optionalCountField(record, 'hops'),
    maxNodes: optionalCountField(record, 'maxNodes'),
    ...(kinds === undefined ? {} : { kinds }),
    ...(relations === undefined ? {} : { relations }),
    ...(extraSeeds === undefined ? {} : { extraSeeds }),
    ...(excludeIds === undefined ? {} : { excludeIds }),
  };
}

/**
 * Parse the `/search` body: exactly one of the two forms.
 *
 * `query` must be at least 2 characters (the ranking is meaningless below
 * that); `limit` is an optional non-negative integer, bounded by the service.
 * `resolve` is an array of `{ name, file }` pairs. A body carrying neither, or
 * both, is a client bug the route refuses instead of guessing.
 */
function readSearchInput(body: unknown): ArchitectureSearchInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const projectId = requireStringField(record, 'projectId');
  const hasQuery = record.query !== undefined;
  const hasResolve = record.resolve !== undefined;
  if (hasQuery === hasResolve) {
    throw invalidRequest('exactly one of "query" or "resolve" is required');
  }

  if (hasQuery) {
    const query = requireStringField(record, 'query');
    if (query.trim().length < 2) {
      throw invalidRequest('"query" must be at least 2 characters');
    }
    const limit = optionalCountField(record, 'limit');
    const kinds = optionalVocabularyField<EntityKind>(record, 'kinds', ENTITY_KINDS);
    return {
      projectId,
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(kinds === undefined ? {} : { kinds }),
    };
  }

  const resolveValue = record.resolve;
  if (!Array.isArray(resolveValue)) {
    throw invalidRequest('"resolve" must be an array of { name, file } objects');
  }
  const resolve = resolveValue.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidRequest(`"resolve[${index}]" must be an object with "name" and "file"`);
    }
    const pair = entry as Record<string, unknown>;
    return {
      name: requireStringField(pair, 'name'),
      file: requireStringField(pair, 'file'),
    };
  });
  return { projectId, resolve };
}

/**
 * Parse the `/mentions` body.
 *
 * At least one of `entityIds` (one or more) or `edge` is required — without a
 * target the query has no meaning, and answering an empty `mentions` array
 * would hide that. `includeToolResults` defaults to false (the extractor's
 * noise tier is opt-in per query); `limit` is a non-negative integer.
 */
function readMentionsInput(body: unknown): ArchitectureMentionsInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const entityIdsValue = record.entityIds;
  let entityIds: string[] | undefined;
  if (entityIdsValue !== undefined) {
    if (!Array.isArray(entityIdsValue) || entityIdsValue.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw invalidRequest('"entityIds" must be an array of non-empty strings');
    }
    entityIds = entityIdsValue as string[];
  }

  const edgeValue = record.edge;
  let edge: { from: string; to: string } | undefined;
  if (edgeValue !== undefined) {
    if (edgeValue === null || typeof edgeValue !== 'object' || Array.isArray(edgeValue)) {
      throw invalidRequest('"edge" must be an object with "from" and "to"');
    }
    const edgeRecord = edgeValue as Record<string, unknown>;
    edge = {
      from: requireStringField(edgeRecord, 'from'),
      to: requireStringField(edgeRecord, 'to'),
    };
  }

  if ((entityIds === undefined || entityIds.length === 0) && edge === undefined) {
    throw invalidRequest('one of "entityIds" or "edge" is required');
  }

  const includeToolResultsValue = record.includeToolResults;
  if (includeToolResultsValue !== undefined && typeof includeToolResultsValue !== 'boolean') {
    throw invalidRequest('"includeToolResults" must be a boolean');
  }

  return {
    projectId: requireStringField(record, 'projectId'),
    sessionId: requireStringField(record, 'sessionId'),
    ...(entityIds === undefined ? {} : { entityIds }),
    ...(edge === undefined ? {} : { edge }),
    ...(includeToolResultsValue === undefined ? {} : { includeToolResults: includeToolResultsValue }),
    ...(record.limit === undefined ? {} : { limit: requireCount(record, 'limit') }),
  };
}

/**
 * Read a required non-negative integer field (a `limit` of zero returns no
 * hits, which is a legal reading rather than a malformed request).
 */
function requireCount(body: Record<string, unknown>, name: string): number {
  const count = optionalCountField(body, name);
  if (count === undefined) throw invalidRequest(`"${name}" must be a non-negative integer`);
  return count;
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

  router.post(
    '/mentions',
    asyncHandler(async (request, response) => {
      const input = readMentionsInput(request.body);
      const result = await service.readMentions(input);
      response.json(result);
    }),
  );

  router.post(
    '/search',
    asyncHandler(async (request, response) => {
      const input = readSearchInput(request.body);
      const result = await service.readSearch(input);
      response.json(result);
    }),
  );

  return router;
}
