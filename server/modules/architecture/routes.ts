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
 * The manual re-analysis has its own pair: `POST /api/architecture/refresh` takes
 * `{ projectId }` and answers 202 with the started-or-joined job (a concurrent
 * request for the same project root answers `coalesced: true` and the same
 * `jobId`), and `GET /api/architecture/refresh/status?projectId=…` answers the
 * current status document. The project is resolved server-side from `projectId`
 * alone: a path or any other field in the start body is IGNORED rather than
 * accepted, so a client cannot point the analysis at a directory the server did
 * not choose.
 *
 * Consumers: `server/modules/architecture/module.ts` (production composition)
 * and `server/modules/architecture/tests/architecture-routes.test.ts`.
 */
import express, { type Router } from 'express';

import type { ArchitectureRefreshStartResult, ArchitectureRefreshStatus } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import { ENTITY_KINDS, RELATION_TYPES, type EntityKind, type RelationType } from './generator.js';
import type { ArchguardRefreshJob } from './refreshJob.js';
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
 * the old, unfiltered reading. `keepMentionedKinds` is the element filter's
 * per-kind "keep mentioned" switch list — same vocabulary, same 400 on an
 * unknown value; it is inert without `kinds`.
 */
function readGraphInput(body: unknown): ArchitectureGraphInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const kinds = optionalVocabularyField<EntityKind>(record, 'kinds', ENTITY_KINDS);
  const keepMentionedKinds = optionalVocabularyField<EntityKind>(
    record,
    'keepMentionedKinds',
    ENTITY_KINDS,
  );
  const relations = optionalVocabularyField<RelationType>(record, 'relations', RELATION_TYPES);
  const extraSeeds = optionalIdListField(record, 'extraSeeds', MAX_EXTRA_SEEDS);
  const excludeIds = optionalIdListField(record, 'excludeIds', MAX_EXCLUDE_IDS);
  return {
    projectId: requireStringField(record, 'projectId'),
    sessionId: requireStringField(record, 'sessionId'),
    hops: optionalCountField(record, 'hops'),
    maxNodes: optionalCountField(record, 'maxNodes'),
    ...(kinds === undefined ? {} : { kinds }),
    ...(keepMentionedKinds === undefined ? {} : { keepMentionedKinds }),
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
 * Read the `/refresh` start body: `{ projectId }` and nothing else.
 *
 * Extra fields are deliberately ignored rather than rejected — the important
 * property is that a `path` (or any other directory hint) has no effect: the
 * service resolves the project root from `projectId` alone.
 */
function readRefreshStartInput(body: unknown): { projectId: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  return { projectId: requireStringField(record, 'projectId') };
}

/** Read the `/refresh/status` query string's required `projectId`. */
function readRefreshStatusInput(query: unknown): { projectId: string } {
  if (query === null || typeof query !== 'object') {
    throw invalidRequest('"projectId" is required');
  }
  const value = (query as Record<string, unknown>).projectId;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest('"projectId" must be a non-empty query parameter');
  }
  return { projectId: value };
}

/**
 * Build the router over one service instance and, when the caller has one, one
 * refresh job.
 *
 * `refreshJob` is optional so the module can be composed without the manual
 * re-analysis (the route factory's unit criteria mount only the three read
 * endpoints); omitting it does not register the refresh pair at all, which is a
 * 404 rather than a made-up job. Production always passes one.
 *
 * Consumers: `server/modules/architecture/module.ts` only; the module's barrel
 * exposes the composed module, not this factory.
 */
export function createArchitectureRoutes(
  service: ArchitectureService,
  refreshJob?: ArchguardRefreshJob,
): Router {
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

  const job = refreshJob;
  if (job !== undefined) {
    router.post(
      '/refresh',
      asyncHandler(async (request, response) => {
        const input = readRefreshStartInput(request.body);
        const result: ArchitectureRefreshStartResult = job.start(input.projectId);
        // 202: the analysis is accepted and running (or already was). The body is
        // the job the caller now owns or joined.
        response.status(202).json(result);
      }),
    );

    router.get(
      '/refresh/status',
      asyncHandler(async (request, response) => {
        const input = readRefreshStatusInput(request.query);
        const result: ArchitectureRefreshStatus = job.status(input.projectId);
        response.json(result);
      }),
    );
  }

  return router;
}
