/**
 * The reply-suggestions module's HTTP face.
 *
 * Three routes live under `/api/reply-suggestions` (mounted behind
 * `authenticateToken` by `server/index.ts`):
 *
 *   · `GET  /status` — the four-field public reading; no key and no path.
 *   · `POST /`       — `{ sessionId, redraw?, focus? }` -> `{ chips, draw }`.
 *   · `POST /events` — `{ sessionId, draw, event, index? }` -> 204.
 *
 * This file only parses transport input, calls one service method and formats
 * the answer. `focus` is passed through whatever its length: the service clips
 * it to `maxFocusChars`, so a long selection is a normal input rather than a
 * 400. `AppError`s from the injected transcript reader (404 for an unknown
 * session) and from the service (503 disabled, 429 over a limit, 502 upstream)
 * travel to the process error middleware unchanged.
 *
 * Consumers: `reply-suggestions.module.ts` (production composition) and the
 * route criterion in `tests/reply-suggestions-routes.test.ts`.
 */
import express, { type Router } from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type {
  ReplySuggestionsEventInput,
  ReplySuggestionsEventName,
  ReplySuggestionsInput,
  ReplySuggestionsService,
} from './reply-suggestions.service.js';

const EVENT_NAMES: readonly ReplySuggestionsEventName[] = ['picked', 'cleared', 'redrawn', 'sent'];

function invalidRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

function requireStringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest(`"${name}" must be a non-empty string`);
  }
  return value;
}

function optionalBooleanField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidRequest(`"${name}" must be a boolean`);
  return value;
}

function requireNonNegativeInteger(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidRequest(`"${name}" must be a non-negative integer`);
  }
  return value;
}

function optionalNonNegativeInteger(body: Record<string, unknown>, name: string): number | undefined {
  if (body[name] === undefined) return undefined;
  return requireNonNegativeInteger(body, name);
}

function readObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function readSuggestInput(body: unknown): ReplySuggestionsInput {
  const record = readObjectBody(body);
  const redraw = optionalBooleanField(record, 'redraw');
  const focusValue = record.focus;
  if (focusValue !== undefined && typeof focusValue !== 'string') {
    throw invalidRequest('"focus" must be a string');
  }
  return {
    sessionId: requireStringField(record, 'sessionId'),
    ...(redraw === undefined ? {} : { redraw }),
    ...(focusValue === undefined ? {} : { focus: focusValue as string }),
  };
}

function readEventInput(body: unknown): ReplySuggestionsEventInput {
  const record = readObjectBody(body);
  const event = record.event;
  if (typeof event !== 'string' || !(EVENT_NAMES as readonly string[]).includes(event)) {
    throw invalidRequest(`"event" must be one of ${EVENT_NAMES.map((name) => `"${name}"`).join(', ')}`);
  }
  const index = optionalNonNegativeInteger(record, 'index');
  return {
    sessionId: requireStringField(record, 'sessionId'),
    draw: requireNonNegativeInteger(record, 'draw'),
    event: event as ReplySuggestionsEventName,
    ...(index === undefined ? {} : { index }),
  };
}

/**
 * Build the router over one service instance.
 *
 * Consumers: `reply-suggestions.module.ts` only; the barrel exposes the composed
 * module, not this factory.
 */
export function createReplySuggestionsRoutes(service: ReplySuggestionsService): Router {
  const router = express.Router();

  router.get(
    '/status',
    asyncHandler(async (_request, response) => {
      response.json(service.status());
    }),
  );

  router.post(
    '/',
    asyncHandler(async (request, response) => {
      const input = readSuggestInput(request.body);
      response.json(await service.suggest(input));
    }),
  );

  router.post(
    '/events',
    asyncHandler(async (request, response) => {
      service.recordEvent(readEventInput(request.body));
      response.status(204).end();
    }),
  );

  return router;
}
