/**
 * The reply-suggestions failure reader, a value leaf directly under `src/shared`
 * beside its type leaf (`replySuggestionsType.ts`).
 *
 * WHY NOT `src/shared/api/requests.ts`: that file is the generic request plumbing,
 * and the reply-suggestions feature readers are not transport primitives. Keeping
 * this one there put `shared/api` at 50 entities — the god-package entity budget
 * (`minEntities=50`, reasons `highFanIn/highFanOut/tooManyEntities`). Here its only
 * consumer (`src/shared/api/clientTail.ts`, the endpoint map) reaches it without
 * growing `shared/api` past 49.
 *
 * WHY ONLY ONE EXPORT: the architecture probe counts public functions and classes
 * per package, so `src/shared` gains exactly one entity (48 -> 49). `readCategory`
 * and `inferCategory` stay private — a second export would put `src/shared` itself
 * at its own `tooManyEntities` threshold. The category vocabulary is exported as
 * data (not an entity) because `requests.ts` still validates the `lastFailure`
 * category of `/status`; keeping one literal copy serves both readers.
 *
 * WHY THIS DIRECTORY (not a subpackage): the two type-only imports below stay
 * inside `src/shared`, and `shared/api -> shared` is the directory edge that
 * already exists for `replySuggestionsType.ts`, so neither the directory-cycle
 * ratchet nor the `src/shared` file-level SCC pin gains a group.
 */
import type {
  ReplySuggestionsFailure,
  ReplySuggestionsFailureCategory,
} from '@/shared/replySuggestionsType';

/** The literal category vocabulary, as data, so a wire value is checked before it is trusted. */
export const REPLY_SUGGESTIONS_FAILURE_CATEGORIES: readonly ReplySuggestionsFailureCategory[] = [
  'timeout', 'http', 'network', 'parse', 'shape', 'circuit-open', 'rate-limit', 'misconfigured', 'unknown',
];

/** Reads a category, or null when the value is not one of the declared members. */
function readCategory(value: unknown): ReplySuggestionsFailureCategory | null {
  return typeof value === 'string' && (REPLY_SUGGESTIONS_FAILURE_CATEGORIES as readonly string[]).includes(value)
    ? value as ReplySuggestionsFailureCategory
    : null;
}

/** A coarse category for a refusal body that carried none: the code and the status are enough. */
function inferCategory(code: string, httpStatus: number | null): ReplySuggestionsFailureCategory {
  if (code === 'REPLY_SUGGESTIONS_RATE_LIMITED' || httpStatus === 429) return 'rate-limit';
  if (code === 'REPLY_SUGGESTIONS_UPSTREAM_FAILED') return httpStatus === null ? 'unknown' : 'http';
  if (httpStatus !== null) return 'http';
  return 'unknown';
}

/**
 * Reads one failed `POST /api/reply-suggestions` answer into the typed failure the
 * controller shows. The error envelope's `code`/`message` and its
 * `details.{requestId,httpStatus,category,model}` are preserved verbatim; an
 * unreadable body reads as `code: 'unknown'` rather than as "no answer".
 */
export function readReplySuggestionsFailure(
  status: number,
  body: unknown,
  fallbackMessage = `HTTP ${status}`,
): ReplySuggestionsFailure {
  const envelope = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const error = envelope.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)
    ? envelope.error as Record<string, unknown>
    : {};
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'unknown';
  const httpStatus = typeof details.httpStatus === 'number' && Number.isInteger(details.httpStatus)
    ? details.httpStatus
    : null;
  return {
    at: new Date().toISOString(),
    code,
    category: readCategory(details.category) ?? inferCategory(code, httpStatus),
    httpStatus,
    requestId: typeof details.requestId === 'string' && details.requestId !== '' ? details.requestId : null,
    model: typeof details.model === 'string' && details.model !== '' ? details.model : null,
    message: typeof error.message === 'string' && error.message !== '' ? error.message : fallbackMessage,
  };
}
