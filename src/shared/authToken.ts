/**
 * The client's half of the JWT session: parsing, expiry, storage and the two
 * events the auth context listens to.
 *
 * Extracted from api.ts, which is meant to be the endpoint map plus its request
 * helpers. This is the security-sensitive part and it is what WebSocketContext,
 * AuthContext, the shell socket and the file-tree uploader actually import.
 *
 * A token's `exp` is arithmetic the SERVER owns. The client used to pre-empt it
 * — `getStoredAuthToken()` deleted a token its own clock called past and
 * `WebSocketContext` refused to connect with one — which meant a browser whose
 * clock ran ahead signed itself out, and the server saw only a request that had
 * arrived without a credential (a bare `invalid-token` 401). The truth was
 * invisible. Now the client keeps the credential and lets the server refuse it,
 * and it writes down WHY it stopped holding a usable token so the next login can
 * report the reason instead of leaving the next debugger to infer it.
 */

export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

/**
 * Where the "why did we stop holding a usable token" breadcrumb is kept.
 *
 * One slot, written at most once between logins: the cause that emptied the
 * session is the first one observed, and a later request that merely runs with
 * no token must not overwrite it. Cleared when a session is established.
 */
const AUTH_LAPSE_STORAGE_KEY = 'auth-lapse';

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

type TokenClaims = {
  issuedAt: number;
  expiresAt: number;
};

const readTokenClaims = (token: unknown): TokenClaims | null => {
  if (!isValidRefreshedToken(token)) {
    return null;
  }

  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(
      encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(atob(paddedPayload)) as { iat?: unknown; exp?: unknown };

    if (
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null;
    }

    return { issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
};

// Tolerance for client/server clock skew. The server's own jwt.verify is the
// real authority; this check only classifies a token's `exp` against the local
// clock, and it is no longer a reason to drop the credential. It survives as the
// vocabulary the expiry breadcrumb uses to name a local-clock judgement, so a
// regression that reintroduces one is recognised rather than merely allowed.
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

export const isAuthTokenExpired = (token: unknown): boolean => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt + TOKEN_EXPIRY_SKEW_MS : false;
};

export const getAuthTokenRefreshDelay = (token: unknown): number | null => {
  const claims = readTokenClaims(token);
  if (!claims) {
    return null;
  }

  const refreshAt = claims.issuedAt + ((claims.expiresAt - claims.issuedAt) / 2);
  return Math.max(0, refreshAt - Date.now());
};

// ─── Why the session lapsed ──────────────────────────────────────────────────

/**
 * The cause of a lapse, as observed by the client.
 *
 *  · `server-401`      — the server refused the credential without saying why.
 *  · `server-expired`  — the server named the token's own `exp` as the reason.
 *  · `storage-empty`   — a request was about to go out holding no token at all.
 *  · `local-clock`     — the client's own clock called the token expired.
 *
 * `local-clock` is deliberately still a member. It is the cause that must NEVER
 * be produced again: the whole point of this work is that the client does not get
 * to expire its own session. It stays in the vocabulary so that if a regression
 * reintroduces a local-clock deletion the breadcrumb it writes is recognisable —
 * a regression detector whose value is already spelled out.
 */
export type AuthLapseReason = 'server-401' | 'server-expired' | 'storage-empty' | 'local-clock';

/**
 * The breadcrumb: why a usable token stopped being held, and when.
 *
 * Carries no credential — only the classification, the moment and the token's
 * `exp`. All instants are epoch milliseconds.
 *
 *  · `reason` — the cause (see `AuthLapseReason`).
 *  · `exp`    — the token's `exp` instant read before it was dropped, or null
 *               when no token was held at all.
 *  · `now`    — the client clock at the moment the lapse was observed.
 *  · `at`     — the same instant as an ISO-8601 string, so a human reading
 *               `localStorage['auth-lapse']` need not convert it by hand.
 */
export type AuthLapseBreadcrumb = {
  reason: AuthLapseReason;
  exp: number | null;
  now: number;
  at: string;
};

/** What a login request reports so the server can print the lapse and the skew. */
export type AuthLapseReport = {
  now: number;
  lapse: AuthLapseBreadcrumb | null;
};

const readLapseBreadcrumb = (): AuthLapseBreadcrumb | null => {
  try {
    const raw = localStorage.getItem(AUTH_LAPSE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthLapseBreadcrumb) : null;
  } catch {
    return null;
  }
};

/**
 * Writes the breadcrumb for a lapse, once per session.
 *
 * First write wins: the cause that ended the session is the first one observed,
 * and the unauthenticated requests that follow must not relabel it. Call
 * `clearAuthLapse()` when a session is established to open the next window.
 *
 * `token` is the credential that was held at the moment of the lapse — passed in
 * because the caller is usually about to remove it, and its `exp` has to be read
 * before it is gone. Omit it to read whatever is still stored.
 */
export const recordAuthLapse = (reason: AuthLapseReason, token?: string | null): void => {
  if (readLapseBreadcrumb()) {
    return;
  }

  const held = token === undefined ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) : token;
  const claims = readTokenClaims(held);
  const now = Date.now();
  const breadcrumb: AuthLapseBreadcrumb = {
    reason,
    exp: claims ? claims.expiresAt : null,
    now,
    at: new Date(now).toISOString(),
  };

  try {
    localStorage.setItem(AUTH_LAPSE_STORAGE_KEY, JSON.stringify(breadcrumb));
  } catch {
    // Storage unreachable (private mode, quota): the console copy below is the
    // whole record then, which is exactly what a debugger needs.
  }
  console.warn(
    `[Auth] session lapse recorded: ${JSON.stringify(breadcrumb)}`,
  );
};

/** The lapse report attached to the next login attempt. Never carries a credential. */
export const readAuthLapseReport = (): AuthLapseReport => ({
  now: Date.now(),
  lapse: readLapseBreadcrumb(),
});

/** Opens a new lapse window; called when a session is established. */
export const clearAuthLapse = (): void => {
  try {
    localStorage.removeItem(AUTH_LAPSE_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
};

/**
 * Ends the session: drop the token and announce it.
 *
 * `reason` is optional so a caller that only knows the server refused the
 * credential can still route through here; when given, it is recorded as the
 * lapse cause. The event is the one and only signal the auth context listens to,
 * so every end-of-session path routes through this function.
 */
export const expireAuthSession = (reason?: AuthLapseReason): void => {
  const held = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  if (reason) {
    recordAuthLapse(reason, held);
  }
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
};

/**
 * The stored token, verbatim.
 *
 * The client does NOT judge it: a token whose `exp` the local clock reads as past
 * is still handed over, because only the server's arithmetic decides whether it
 * is acceptable. Null means "nothing is stored", not "what is stored is bad".
 */
export const getStoredAuthToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

/**
 * A token's `iat` as epoch milliseconds, or null when it is not a readable JWT.
 *
 * The primitive a monotonic comparison is built on: two tokens can be ordered by
 * when the server minted them without decoding the rest of the payload. Null
 * covers both "not a token" and "claims unreadable", because neither can be
 * compared against anything.
 */
export const readTokenIssuedAt = (token: unknown): number | null => {
  const claims = readTokenClaims(token);
  return claims ? claims.issuedAt : null;
};

/**
 * The observable reading for a renewed token the client refused to adopt.
 *
 * Same `[Auth]` channel the lapse breadcrumb speaks on, so a debugger watching
 * the console sees the client's decision without a second logging mechanism —
 * but written ONLY to the console, never to `auth-lapse`: the session is still
 * live, and spending the breadcrumb's first-write-wins slot on a non-lapse would
 * mislabel whatever really ends it. No credential is written, only the
 * classification and the two instants.
 */
const recordRefreshedTokenDiscarded = (
  kind: 'older' | 'same-instant' | 'unparseable',
  incomingIssuedAt: number | null,
): void => {
  console.warn(
    `[Auth] discarded X-Refreshed-Token (${kind}): ${JSON.stringify({
      kind,
      incomingIat: incomingIssuedAt,
      heldIat: readTokenIssuedAt(getStoredAuthToken()),
      now: Date.now(),
    })}`,
  );
};

/**
 * Adopts a token the server sent in `X-Refreshed-Token` — but only when it is an
 * improvement on the one already held.
 *
 * WHY THIS IS NOT `storeAuthToken`. A refreshed token is a renewal the SERVER
 * decided to hand back; the client's job is to keep the newest one it has seen,
 * never to move backwards. The observed defect: `/api/*` responses were
 * browser-cacheable, so a reload replayed a days-old response and its terminal
 * `X-Refreshed-Token`, and the unconditional `storeAuthToken` wrote that ancient
 * token back over the fresh one. Each reload rolled the session further back
 * until the replayed token's `exp` finally passed, and every reload signed the
 * user out.
 *
 * THE RULE: accept only a token STRICTLY NEWER than the one held (by `iat`), and
 * only when it parses. Older, same-instant and unparseable tokens are dropped,
 * each leaving the reading above. With nothing held there is nothing to roll
 * back, so the renewal is adopted — the ordinary "session established elsewhere"
 * path. A malformed header value still cannot overwrite the stored token, the
 * guarantee `isValidRefreshedToken` already carried.
 *
 * `storeAuthToken` keeps its unconditional semantics for every OTHER caller
 * (login, session establishment); only a server-pushed renewal comes through here.
 */
export const acceptRefreshedAuthToken = (token: unknown): boolean => {
  const incomingIssuedAt = readTokenIssuedAt(token);
  if (incomingIssuedAt === null) {
    recordRefreshedTokenDiscarded('unparseable', null);
    return false;
  }

  const heldIssuedAt = readTokenIssuedAt(getStoredAuthToken());
  if (heldIssuedAt !== null && incomingIssuedAt <= heldIssuedAt) {
    recordRefreshedTokenDiscarded(
      incomingIssuedAt === heldIssuedAt ? 'same-instant' : 'older',
      incomingIssuedAt,
    );
    return false;
  }

  return storeAuthToken(token);
};

export const storeAuthToken = (token: unknown): boolean => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }

  localStorage.setItem('auth-token', token);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  }
  return true;
};
