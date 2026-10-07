/**
 * OAuth consent transport (gap-oauth-consent-spa-backend-contract).
 *
 * The authorization endpoint plus the JSON API the consent SPA drives. The
 * server no longer renders the consent screen: `GET /oauth/authorize` keeps
 * every check it always had (client_id present and enabled, `response_type=code`,
 * `redirect_uri` verbatim in the client's registered set — RFC 6749 §3.1.2.4,
 * an unregistered callback is shown an error page and NEVER redirected to) and
 * then answers `302` to the client-side route {@link OAUTH_CONSENT_SPA_PATH},
 * carrying the request's original query. A request that fails validation is
 * answered with an HTML error page and no `Location`.
 *
 * The SPA then calls the two JSON routes under `/api/oauth/authorize`, which are
 * authenticated by the ordinary application bearer JWT (mounted with
 * `authenticateToken` by `oauth-server.mount.ts` — this file never inspects a
 * token itself, so a browser tab cannot be tricked into driving the flow
 * cross-site the way a form POST could):
 *
 *   GET  /context   → `{clientName, callbackHost, redirectUri, scopes, state,
 *                     clientCreatedAt, clientCreatedVia, accessTokenTtlSeconds}`
 *   POST /decision  → `{redirectTo}` — the SPA performs the navigation with
 *                     `window.location`, so no server CSP `form-action` applies
 *                     to the client's callback chain.
 *
 * Both re-run the same `(client_id, redirect_uri)` validation the browser-facing
 * route does, so the deny branch cannot be used as an open redirector. All
 * policy — vocabulary, pinned scope, granted-set computation — is in
 * `oauth-consent.service.ts`; this file is transport.
 *
 * PASSWORD CONFIRMATION (AC-261, narrowed by
 * gap-oauth-consent-flow-ux-hardening): when the composition root injects a
 * `verifyCredentials`, the `allow` branch requires the signed-in user's password
 * once more before it mints a code — but only when the decision's GRANT SET
 * reaches past `cloudcli:read`. A read-only grant is within what the session JWT
 * already reads, so the session alone authorizes it; any state-changing scope
 * needs the password. The requirement is derived from the service's
 * `grantedScopes`, never from a client-supplied flag. The check is bounded by the
 * injected {@link ConsentPasswordRateLimiter}: ten failures per source per
 * fifteen minutes, with the source resolved from `CF-Connecting-IP` only when
 * the deployment declares a trusted proxy; the limiter is consulted only on the
 * password branch, so a read-only decision never spends a source's budget. A
 * mount that injects no verifier keeps the session-only behavior, which is why
 * AC-260's criterion — which mounts without one — is unchanged.
 *
 * Consumers: `oauth-server.mount.ts` (mounts both factories; the entrypoint
 * mounts the document-header middleware at {@link OAUTH_CONSENT_SPA_PATH} ahead
 * of the static layer), the server entrypoint, and this module's criteria
 * `tests/oauth-consent-page.test.ts`, `tests/oauth-consent-ratelimit.test.ts`
 * and `../mcp-gateway/tests/oauth-flow.e2e.test.ts`.
 */

import express from 'express';
import type { RequestHandler } from 'express';

import type { CredentialVerifier } from '@/modules/auth/index.js';
import type { OAuthClientRow } from '@/modules/database/index.js';
import {
  OAUTH_CONSENT_READ_SCOPE,
  consentScopeOptions,
  grantedScopes,
  readConsentRequest,
} from '@/modules/oauth/oauth-consent.service.js';
import type { OAuthConsentClients } from '@/modules/oauth/oauth-consent.service.js';
import { createConsentPasswordRateLimiter } from '@/modules/oauth/oauth-consent-ratelimit.service.js';
import type { ConsentPasswordRateLimiter } from '@/modules/oauth/oauth-consent-ratelimit.service.js';
import type { OAuthProvider } from '@/modules/oauth/oauth-provider.service.js';

import { OAUTH_CONSENT_SPA_PATH } from '../../../shared/oauthConsent.js';

/** `authenticateToken` attaches the DB user row; this is the shape both JSON routes read. */
type AuthenticatedRequest = express.Request & { user?: { id?: number | string; username?: string } };

/** The one field the JSON routes read off the authenticated principal. */
function authenticatedUserId(req: express.Request): number {
  return Number((req as AuthenticatedRequest).user?.id);
}

/** The signed-in user's own login name, the fallback identity for a password confirmation. */
function authenticatedUsername(req: express.Request): string {
  const username = (req as AuthenticatedRequest).user?.username;
  return typeof username === 'string' ? username : '';
}

/** A query/body value only when it is a single string (an array or object is not a usable scalar). */
function firstString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Coerces a repeated JSON field (a string or a string array) to an array of strings. */
function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/** The request's query string exactly as it arrived, without the `?`. */
function rawQuery(req: express.Request): string {
  const index = req.originalUrl.indexOf('?');
  return index === -1 ? '' : req.originalUrl.slice(index + 1);
}

/**
 * The anti-framing / no-store posture the consent surface carries. The SPA
 * document gets `frame-ancestors 'none'` only — NOT the `default-src 'none'` the
 * HTML error page uses — because the shell's own bundle has to load and run.
 */
function applyConsentHeaders(res: express.Response): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
}

/** Sends an RFC 6749 §5.2 error object with the consent surface's headers. */
function sendJsonError(res: express.Response, status: number, error: string, message: string): void {
  applyConsentHeaders(res);
  res.status(status).json({ error, error_description: message });
}

/** Sends a JSON body with the consent surface's headers. */
function sendJson(res: express.Response, status: number, payload: Record<string, unknown>): void {
  applyConsentHeaders(res);
  res.status(status).json(payload);
}

/**
 * The route-level middleware that carries the consent surface's headers onto the
 * SPA DOCUMENT.
 *
 * The document is served by `createStaticAssetsMiddleware`, whose SPA catch-all
 * sets its own `Cache-Control` for `index.html` before it terminates the
 * response, so headers set once here would be overwritten on exactly the route
 * they are for. Re-asserting them at `writeHead` — which Node also calls for an
 * implicit header flush, and which a `res.redirect` reaches too — makes the
 * posture win on the document, on the dev redirect and on a 404 alike.
 */
export function createOAuthConsentDocumentHeadersMiddleware(): RequestHandler {
  return (_req, res, next) => {
    applyConsentHeaders(res);
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => express.Response;
    res.writeHead = ((...args: unknown[]) => {
      applyConsentHeaders(res);
      return writeHead(...args);
    }) as typeof res.writeHead;
    next();
  };
}

/** Escapes `& < > " '` so an attacker-controlled value cannot break out of text or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders a minimal HTML error page (no form, no secrets) with the security headers. */
function sendErrorPage(res: express.Response, status: number, message: string): void {
  applyConsentHeaders(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.status(status).type('html').send(
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head>'
    + `<body><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`
  );
}

/** Caller-supplied seams for {@link createOAuthConsentRouter}. */
export type OAuthConsentRouterOptions = {
  /** Client lookup (AC-258's `oauthClientsDb` in production); only `findById` is consumed. */
  clients: OAuthConsentClients;
};

/**
 * The authorization endpoint. Validates the request against the client row and
 * the registered callback set, then hands the browser to the SPA route with the
 * original query intact. Nothing here issues a code: the code is minted only by
 * a decision the authenticated user has seen and clicked.
 */
export function createOAuthConsentRouter(options: OAuthConsentRouterOptions): express.Router {
  const router = express.Router();

  router.get('/authorize', (req, res) => {
    const clientId = firstString(req.query.client_id);
    const responseType = firstString(req.query.response_type);
    const redirectUri = firstString(req.query.redirect_uri);

    if (clientId === null) {
      sendErrorPage(res, 400, 'Missing client_id');
      return;
    }
    if (responseType !== 'code') {
      sendErrorPage(res, 400, 'Unsupported response_type; only "code" is allowed');
      return;
    }
    const reading = readConsentRequest(options.clients, { clientId, redirectUri });
    if (!reading.ok) {
      sendErrorPage(res, reading.status, reading.message);
      return;
    }

    // Same-origin, relative, and the query is passed through unchanged: the SPA
    // re-runs the same validation against `/api/oauth/authorize/context`, so the
    // redirect carries no authority of its own.
    const query = rawQuery(req);
    applyConsentHeaders(res);
    res.redirect(302, `${OAUTH_CONSENT_SPA_PATH}${query === '' ? '' : `?${query}`}`);
  });

  return router;
}

/** Caller-supplied seams for {@link createOAuthAuthorizeApiRouter}. */
export type OAuthAuthorizeApiOptions = {
  /** Authorization-server semantics (AC-259); only `authorize` is consumed. */
  provider: OAuthProvider;
  /** Client lookup, the same one the browser-facing route uses. */
  clients: OAuthConsentClients;
  /**
   * The non-throwing password check (the auth module's `credentialVerifier` in
   * production). When supplied, the `allow` branch requires the signed-in user's
   * password and rate-limits the attempt; when omitted the branch is the plain
   * session-only decision AC-260 pinned.
   */
  verifyCredentials?: CredentialVerifier;
  /** Whether `CF-Connecting-IP` may name the rate-limit source; defaults to the `TRUST_PROXY` env. */
  trustProxy?: boolean;
  /** Injectable password limiter; defaults to one built from `trustProxy`. */
  rateLimiter?: ConsentPasswordRateLimiter;
};

/**
 * The JSON API the consent SPA drives. Both routes assume the caller has already
 * passed `authenticateToken` (`oauth-server.mount.ts` mounts them behind it) and
 * read only `req.user`.
 *
 * `state` is echoed verbatim — it is the client's own opaque value, and the SPA
 * needs it back. A refusal is a `400` JSON object with no `redirectTo` at all,
 * so neither branch can be turned into an open redirector by an unregistered
 * callback.
 */
export function createOAuthAuthorizeApiRouter(options: OAuthAuthorizeApiOptions): express.Router {
  const router = express.Router();
  const rateLimiter =
    options.rateLimiter ?? createConsentPasswordRateLimiter({ trustProxy: options.trustProxy });

  router.get('/context', (req, res) => {
    const clientId = firstString(req.query.client_id);
    const redirectUri = firstString(req.query.redirect_uri);
    const reading = readConsentRequest(options.clients, { clientId, redirectUri });
    if (!reading.ok) {
      sendJsonError(res, reading.status, reading.error, reading.message);
      return;
    }
    sendJson(res, 200, {
      clientName: reading.clientName,
      callbackHost: reading.callbackHost,
      redirectUri: reading.redirectUri,
      scopes: consentScopeOptions(),
      state: firstString(req.query.state),
      // The client's own registration facts, shown as data on the screen: DCR is
      // open, so the name is self-reported and these are the only provenance
      // facts a user has. Null when the column is unrecorded.
      clientCreatedAt: reading.clientCreatedAt,
      clientCreatedVia: reading.clientCreatedVia,
      // The real access-token lifetime, read from the provider so the screen
      // never carries a hardcoded copy of it.
      accessTokenTtlSeconds: options.provider.accessTokenTtlSeconds,
    });
  });

  router.post('/decision', express.json(), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = firstString(body.client_id);
    const redirectUri = firstString(body.redirect_uri);
    const state = firstString(body.state);
    const action = firstString(body.action);

    // The registered-callback check runs BEFORE either branch: the deny branch
    // would otherwise be an open redirector.
    const reading = readConsentRequest(options.clients, { clientId, redirectUri });
    if (!reading.ok) {
      sendJsonError(res, reading.status, reading.error, reading.message);
      return;
    }
    if (action !== 'allow' && action !== 'deny') {
      sendJsonError(res, 400, 'invalid_request', 'Unknown action; expected "allow" or "deny"');
      return;
    }

    const target = new URL(reading.redirectUri);
    if (action === 'deny') {
      target.searchParams.set('error', 'access_denied');
      if (state !== null) {
        target.searchParams.set('state', state);
      }
      sendJson(res, 200, { redirectTo: target.toString() });
      return;
    }

    // What this decision would grant, computed once by the service: the
    // vocabulary filter (out-of-vocabulary scopes are dropped before any
    // decision is taken) and the forced read scope live in one place. The GRANT
    // SET — never a client-supplied "read-only" flag — decides whether the
    // password is required: a grant of nothing but the read scope is within what
    // the session JWT already reads, so the session alone may authorize it; any
    // state-changing scope needs the password again. A forged body that dresses a
    // write scope up as read-only still lands in the grant set and is refused
    // without a valid password.
    const grant = grantedScopes(stringArray(body.scopes));
    const requiresPassword = grant.some((scope) => scope !== OAUTH_CONSENT_READ_SCOPE);

    // Password confirmation (AC-261): only when a verifier is injected AND the
    // grant reaches past the read scope, and only on the allow branch — a denial
    // grants nothing, so it needs no re-auth and no rate limiting. A blocked
    // source is refused BEFORE the password is even looked at, so the eleventh
    // attempt learns nothing from a correct password and no code is minted. The
    // limiter counts only this branch: a read-only decision never spends a
    // source's budget.
    if (options.verifyCredentials !== undefined && requiresPassword) {
      const source = rateLimiter.source(req);
      if (rateLimiter.isBlocked(source)) {
        res.setHeader('Retry-After', String(Math.ceil(rateLimiter.retryAfterMs(source) / 1000)));
        sendJsonError(res, 429, 'too_many_requests', 'Too many password attempts; try again later');
        return;
      }
      const password = firstString(body.password) ?? '';
      const username = firstString(body.username) ?? authenticatedUsername(req);
      // An absent password is a failed confirmation, not a bypass: record it so it
      // counts toward the source's budget like any other wrong credential.
      const verified = password === '' ? { ok: false as const } : await options.verifyCredentials(username, password);
      if (!verified.ok) {
        rateLimiter.recordFailure(source);
        sendJsonError(res, 401, 'invalid_credentials', 'Incorrect username or password');
        return;
      }
      // A confirmed password clears only this source's bucket: another client
      // (or another proxy-forwarded address) must keep its own failure count.
      rateLimiter.resetSource(source);
    }

    const authorized = options.provider.authorize({
      clientId: reading.clientId,
      redirectUri: reading.redirectUri,
      codeChallenge: firstString(body.code_challenge) ?? undefined,
      codeChallengeMethod: firstString(body.code_challenge_method) ?? undefined,
      scopes: grant,
      userId: authenticatedUserId(req),
    });
    if (!authorized.ok) {
      sendJsonError(res, 400, authorized.error, `Authorization failed: ${authorized.error}`);
      return;
    }

    target.searchParams.set('code', authorized.code);
    if (state !== null) {
      target.searchParams.set('state', state);
    }
    sendJson(res, 200, { redirectTo: target.toString() });
  });

  return router;
}
