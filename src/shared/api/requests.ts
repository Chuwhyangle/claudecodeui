/**
 * The request plumbing every endpoint goes through: verb helpers, query serialization,
 * the envelope reader, the URL builders a non-`fetch` consumer needs, and the
 * reply-suggestions draw/status readers.
 *
 * The failed-draw reader is NOT here: it lives in `src/shared/replySuggestionsFailure.ts`
 * beside its type leaf. It is feature vocabulary rather than transport, and keeping it
 * here put this package at 50 entities — the god-package `tooManyEntities` threshold.
 * `clientTail.ts` (its only consumer) imports it from that leaf directly.
 *
 * WHY THIS IS NOT (ANY MORE) PART OF `index.ts`. `voiceConfig.ts` has to reach
 * `api.voice.config/saveConfig/capture` because the settings document lives on the server,
 * and the barrel `index.ts` value-imports `voiceConfig.ts` for the transcription path.
 * Keeping both directions in one package made those two files one file-level value SCC,
 * invisible to the directory-level cycle ratchets. The endpoint map now lives in
 * `client.ts` (composed from `clientCore.ts` + `clientTail.ts`) and imports these helpers
 * from here, so `voiceConfig.ts` -> `client.ts` never points back at the barrel.
 *
 * `index.ts` re-exports the public names below unchanged; call sites keep importing from
 * `@/shared/api`.
 */
import {
  acceptRefreshedAuthToken,
  expireAuthSession,
  getStoredAuthToken,
  recordAuthLapse,
} from '@/shared/authToken';
import type {
  ActivitySnapshotFrame,
  SessionMessagesQuery,
} from '@/shared/types';
import type {
  ReplySuggestionsFailureCategory,
  ReplySuggestionsLastFailure,
  ReplySuggestionsResult,
  ReplySuggestionsState,
  ReplySuggestionsStatus,
} from '@/shared/replySuggestionsType';
// The ONE client-side category vocabulary: the failed-draw reader owns it, and the
// `/status` last-failure reader below validates against the same list.
import { REPLY_SUGGESTIONS_FAILURE_CATEGORIES } from '@/shared/replySuggestionsFailure';
import { IS_PLATFORM } from '@/shared/utils';

// Headers are a plain record rather than the full `HeadersInit` union so the
// defaults below can be merged with a caller's headers by spreading.
export type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// Utility function for authenticated API calls
export const authenticatedFetch = (
  url: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const token = getStoredAuthToken();

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  // A request is about to leave holding no credential. That is itself the fact
  // worth recording: it is the shape the server sees as a bare `invalid-token`
  // 401 and cannot explain — a session that never existed, storage another tab
  // emptied, and (before this change) a token the client's own clock discarded
  // all look identical from there. First write wins, so a real lapse already on
  // record is not relabelled by the traffic that follows it.
  if (!IS_PLATFORM && !token) {
    recordAuthLapse('storage-empty');
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      // A renewal only moves the session FORWARD. A response the browser replayed
      // from its cache carries the token that was current when it was stored, so
      // accepting it blindly would downgrade the session on every reload — this is
      // the "every refresh logs you out" defect. Older, same-instant and
      // unparseable values are dropped; the decision is the one `storeAuthToken`
      // would make for a login, plus the monotonicity that only a renewal needs.
      acceptRefreshedAuthToken(refreshedToken);
    }
    const authError = response.headers.get('X-Auth-Error');
    if (authError) {
      // The server decided. Name its answer in the breadcrumb: `session-expired`
      // is the token's own `exp` having passed; anything else is a refused
      // credential whose reason the client does not get to guess.
      expireAuthSession(authError === 'session-expired' ? 'server-expired' : 'server-401');
    }
    return response;
  });
};

// ─── Request helpers ────────────────────────────────────────────────────────
// Every endpoint below goes through these so verb, JSON encoding and query
// serialization stay consistent across the whole frontend.

export type QueryValue = string | number | boolean | null | undefined;

// Serializes a query object into `?a=1&b=2` (or an empty string). Empty and
// `false` values are dropped so optional flags can be passed unconditionally.
export const query = (params: Record<string, QueryValue>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/**
 * Reads a `{ success, error, details }` envelope response, throwing the server's
 * message when the request failed.
 *
 * Endpoints return a bare Response, so call sites unwrap it themselves. Most do
 * so in ways that differ deliberately (bare casts where the caller inspects the
 * payload, abort-aware reads in the git panel); this is the shared form for
 * callers that want a failed request to throw.
 */
export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, options: { code?: string; details?: unknown; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
  }
}

/**
 * Reads a `{ success, error, details }` envelope response, throwing an
 * ApiRequestError carrying the server's machine-readable error code when one
 * is present. Accepts both legacy string envelopes (`error: 'message'`) and
 * the structured AppError envelope (`error: { code, message, details }`).
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const raw = data.error ?? data.details;
    const payload = raw && typeof raw === 'object' ? raw : {};
    const message = (typeof raw === 'string' ? raw : payload?.message) || data.details || `Request failed (${response.status})`;
    throw new ApiRequestError(message, {
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      details: payload?.details ?? data.details,
      status: response.status,
    });
  }
  return data as T;
}
export const get = (url: string, options: ApiRequestOptions = {}) => authenticatedFetch(url, options);

/**
 * Reads a session's activity snapshot over REST (`GET /:sessionId/activity`).
 *
 * This is the join path for a client that arrives after a change: the socket
 * hands a whole snapshot on `activity.snapshot` when it subscribes, and this
 * route answers the same object shape for a reader that wants it before the
 * socket is up (or wants to prove the snapshot exists). The response body IS the
 * snapshot — not an envelope — so it is returned as-is; a 404 (no snapshot for
 * the session) reads as `null` rather than throwing, because "this session has no
 * activity yet" is a normal state, not a failure.
 */
export async function fetchSessionActivity(
  sessionId: string,
): Promise<ActivitySnapshotFrame | null> {
  const response = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity`);
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' ? (body as ActivitySnapshotFrame) : null;
}

const withBody =
  (method: string) =>
    (url: string, body?: unknown, options: ApiRequestOptions = {}) =>
      authenticatedFetch(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...options,
      });

export const post = withBody('POST');
export const put = withBody('PUT');
export const patch = withBody('PATCH');
export const del = withBody('DELETE');

// ─── URL builders ───────────────────────────────────────────────────────────
// Exported for the consumers that cannot go through `authenticatedFetch`:
// `EventSource` and `XMLHttpRequest` need a bare URL.

/**
 * Persisted messages for one session, in either of the route's two shapes.
 *
 * Omitting `limit` requests the whole transcript; passing one always pairs it with
 * an explicit offset so automatic refreshes can never accidentally become an
 * unbounded transcript request. When `around` is set the URL is the id-anchored
 * window read instead (`?around=<id>&before=B&after=A`) and `limit`/`offset` are
 * dropped, matching the server's own precedence.
 */
export const sessionMessagesUrl = (
  sessionId: string,
  { limit = null, offset = 0, around, before, after }: SessionMessagesQuery = {},
): string => {
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  if (around !== undefined) {
    return `${base}${query({ around, before, after })}`;
  }
  return limit === null || limit === undefined
    ? base
    : `${base}${query({ limit, offset: offset ?? 0 })}`;
};

/**
 * The `/voice-realtime` socket URL for the open session (GOAL-031 / AC-312).
 *
 * A browser WebSocket handshake cannot carry an `Authorization` header, so the
 * JWT rides in the query — the same shape the chat socket uses. `session` names
 * the ONE session a voice `session_send` may reach; the server holds a model
 * that tries to name another to it (`createVoiceRealtimeLiveExecutor`), so the
 * "currently open session" binding is decided here and enforced there.
 */
export const voiceRealtimeSocketUrl = (token: string, sessionId: string): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/voice-realtime${query({ token, session: sessionId })}`;
};

export const fileContentPath = (projectId: string, filePath: string) =>
  `/api/file-tree/projects/${projectId}/files/content${query({ path: filePath })}`;

export const pluginAssetPath = (pluginName: string, assetFile: string) =>
  `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(assetFile)}`;

// ─── Reply-suggestions response reading ─────────────────────────────────────
// The composer hooks hand these two parsers every answer the reply-suggestions
// endpoints produce, so no call site touches a `Response` or trusts a shape.
// A refused (non-2xx) or unreadable answer reads as `null`, which the controller
// treats as the silent fallback to the habit chips.

/** Most chips one draw may return when the caller has no `/status` reading. */
export const DEFAULT_REPLY_SUGGESTIONS_MAX_CHIPS = 3;

/**
 * Reads one draw: drops non-string and blank elements, trims what remains and
 * caps the batch at `maxChips`. A body that is not an object is a failed read.
 */
export function readReplySuggestionsResult(body: unknown, maxChips: number): ReplySuggestionsResult | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const chips: string[] = [];
  if (Array.isArray(record.chips)) {
    for (const item of record.chips) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (!text) continue;
      chips.push(text);
      if (chips.length >= maxChips) break;
    }
  }
  return {
    chips,
    draw: typeof record.draw === 'number' && Number.isFinite(record.draw) ? record.draw : 0,
  };
}

/**
 * Reads the `/status` answer: the four draw fields plus the three visibility
 * fields (`state`, `problems`, `lastFailure`). A missing or mistyped field falls
 * back to the disabled/default reading rather than propagating a malformed shape;
 * an older server that predates `state` reads as enabled-implied-ready / off.
 */
export function readReplySuggestionsStatus(body: unknown): ReplySuggestionsStatus | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const enabled = record.enabled === true;
  return {
    enabled,
    state: readState(record.state, enabled),
    problems: Array.isArray(record.problems)
      ? record.problems.filter((problem): problem is string => typeof problem === 'string')
      : [],
    lastFailure: readLastFailure(record.lastFailure),
    expansion: record.expansion === 'vary' ? 'vary' : 'off',
    maxChips: typeof record.maxChips === 'number' ? record.maxChips : DEFAULT_REPLY_SUGGESTIONS_MAX_CHIPS,
    maxChipChars: typeof record.maxChipChars === 'number' ? record.maxChipChars : 120,
    // A server that predates the debug ledger omits it; an absent/mistyped value is OFF.
    debugLog: record.debugLog === true,
  };
}

/** Validates one `/status` state; an older server's missing field derives from `enabled`. */
function readState(value: unknown, enabled: boolean): ReplySuggestionsState {
  if (value === 'ready' || value === 'misconfigured' || value === 'off') return value;
  return enabled ? 'ready' : 'off';
}

/** The last-failure record, validated field by field; anything unusable reads as null. */
function readLastFailure(value: unknown): ReplySuggestionsLastFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || typeof record.requestId !== 'string') return null;
  const category = readCategory(record.category);
  if (category === null) return null;
  return {
    at: record.at,
    requestId: record.requestId,
    category,
    httpStatus: typeof record.httpStatus === 'number' ? record.httpStatus : null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    model: typeof record.model === 'string' ? record.model : '',
    protocol: record.protocol === 'openai' ? 'openai' : 'anthropic',
  };
}

/** Reads a category, or null when the value is not one of the declared members. */
function readCategory(value: unknown): ReplySuggestionsFailureCategory | null {
  return typeof value === 'string' && (REPLY_SUGGESTIONS_FAILURE_CATEGORIES as readonly string[]).includes(value)
    ? value as ReplySuggestionsFailureCategory
    : null;
}
