/**
 * `/mcp` bearer-token authentication (AC-241, extended by AC-263).
 *
 * `/mcp` accepts personal access tokens (`ccp_…`) issued by the OAuth module and,
 * once the MCP OAuth switch is on, OAuth access tokens (`cca_…`) issued by the
 * authorization server. The middleware parses `Authorization: Bearer <token>`
 * with the SAME shared parser the `/api/oauth/token-info` route uses, hands a
 * `ccp_` token to the INJECTED `AccessTokensService` and every other token to the
 * INJECTED OAuth verification seam (AC-263), and refuses everything that fails
 * with one identical 401 body.
 *
 * The prefix is a ROUTING hint, never a trust boundary: a `ccp_` value is still
 * verified by the token service and a non-`ccp_` value by the OAuth seam, so a
 * forged prefix reaches no shortcut.
 *
 * The two services are injected, never constructed here: `server/index.ts` builds
 * one token service and one OAuth seam and feeds them in, so a process has
 * exactly one verification path per token kind. The middleware deliberately does
 * NOT branch on a rejection reason — not_found, expired, revoked, invalid_prefix,
 * insufficient_scope, a wrong audience and an unknown OAuth token all answer the
 * same bytes, so `/mcp` cannot be used as an oracle. Revocation and expiry take
 * effect on the next request because each service re-reads its row on every call.
 *
 * While OAuth is on, every rejection also carries the RFC 9728 `WWW-Authenticate`
 * challenge pointing at this resource's protected-resource metadata, so a client
 * can DISCOVER where to authenticate (AC-263 leg (a)). The switch is read through
 * `readMcpOauthEnabled` (AC-242's single reader) on EVERY request, never cached,
 * so a criterion can flip it in one process.
 *
 * This module imports no database handle, hashes no token and never re-implements
 * verification: it only calls the injected seams.
 */

import type { RequestHandler, Response } from 'express';

import type { AccessTokensService } from '@/modules/oauth/index.js';
import type { McpPrincipal } from '@/shared/mcp-contract/index.js';
import { bearerToken } from '@/shared/utils.js';

import { readMcpOauthEnabled } from './mcp-gateway.loopback.js';

// The authenticated caller's shape lives in the contract
// (`server/shared/mcp-contract/principal.ts`, proposal stage 1); it is
// re-exported here so the gateway barrel and existing consumers keep importing
// the same name from the same module.
export type { McpPrincipal };

/**
 * The OAuth access-token verifier's verdict, as `/mcp` consumes it (AC-263). On
 * success it names the token ROW and the OAuth client the authorizing grant
 * belongs to, so the principal carries the audit identity; on failure it carries
 * no reason — the middleware never branches on one.
 *
 * This is structurally the success half of AC-259's
 * `VerifyOAuthAccessTokenResult`, so the composition root can pass the provider's
 * method through without adapting it.
 */
export type McpOauthVerification =
  | { ok: true; userId: number; tokenId: number; clientId: string | null; scopes: string[] }
  | { ok: false };

/**
 * The OAuth verification seam AC-263 injects into the middleware: the public base
 * URL (for the discovery challenge) plus the access-token verifier, which binds a
 * token to the given audience. Consumers: `server/index.ts`, which adapts the
 * AC-259 provider onto it, and the AC-263 criterion, which passes a provider over
 * its own temp database.
 */
export type McpOauthSeam = {
  publicBaseUrl: string;
  verifyAccessToken(token: string, options: { resource: string }): McpOauthVerification;
};

/**
 * The middleware's seams. `tokens` is required; `oauth` is present only once the
 * OAuth endpoint is wired, and its ABSENCE keeps `/mcp` PAT-only. `env` defaults
 * to `process.env` and is what the per-request OAuth switch is read from — the
 * criterion passes a mutable object so both switch states are observable in one
 * process.
 */
export type McpAuthMiddlewareOptions = {
  tokens: AccessTokensService;
  oauth?: McpOauthSeam;
  env?: NodeJS.ProcessEnv;
};

/**
 * The one 401 body `/mcp` ever returns for a rejected credential. Byte-for-byte
 * the body `/api/oauth/token-info` returns, and identical across every rejection
 * reason, so the response never leaks WHY the token was refused.
 */
const UNAUTHORIZED_BODY = { error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' };

/** Where the authenticated principal lives on `res.locals`. */
const MCP_PRINCIPAL_LOCAL = 'mcpPrincipal';

/** The personal-access-token prefix that routes a token to the token service. */
const PAT_PREFIX = 'ccp_';

/**
 * The protected-resource metadata path the challenge points at. Appended to
 * `oauth.publicBaseUrl` verbatim (no encoding, no rewriting), it is the RFC 9728
 * document AC-262 mounts.
 */
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp';

/**
 * Builds the `/mcp` authentication middleware that sits in front of the
 * transport. Consumers: `server/index.ts`, which injects the process's single
 * `AccessTokensService` (and, once OAuth is on, the provider-backed seam), and
 * this module's criteria. A caller must never build a second token service for
 * `/mcp`.
 *
 * Accepts EITHER the token service directly (AC-241's call shape) OR the full
 * options bag — the direct form is kept so AC-241's criterion, which predates the
 * OAuth seam, keeps its single-argument call.
 */
export function createMcpAuthMiddleware(
  tokensOrOptions: AccessTokensService | McpAuthMiddlewareOptions
): RequestHandler {
  const options: McpAuthMiddlewareOptions =
    'verifyToken' in tokensOrOptions ? { tokens: tokensOrOptions } : tokensOrOptions;
  const { tokens, oauth } = options;
  const env = options.env ?? process.env;

  return (req, res, next) => {
    // Read the switch on every request: never cached, so one mounted app observes
    // a flip with no restart (AC-263's criterion reads both states in one process).
    const oauthEnabled = readMcpOauthEnabled(env);

    const principal = resolvePrincipal(bearerToken(req.headers.authorization), tokens, oauth, oauthEnabled);
    if (principal === null) {
      rejectUnauthorized(res, oauth, oauthEnabled);
      return;
    }

    res.locals[MCP_PRINCIPAL_LOCAL] = principal;
    next();
  };
}

/**
 * Resolves the request's principal through the injected seams, or `null` for a
 * rejected credential. Pure and reason-free: every failure is `null`, so the
 * caller cannot leak a reason. `ccp_` values go to the token service (whose PAT
 * branch reports `clientId: null`); every other value goes to the OAuth seam only
 * while the switch is on and the seam is present.
 */
function resolvePrincipal(
  token: string | null,
  tokens: AccessTokensService,
  oauth: McpOauthSeam | undefined,
  oauthEnabled: boolean
): McpPrincipal | null {
  if (token === null) {
    return null;
  }

  if (token.startsWith(PAT_PREFIX)) {
    const verified = tokens.verifyToken(token);
    if (!verified.ok) {
      return null;
    }
    // `clientId` is null: a PAT is not issued to an OAuth client (SPEC: "client
    // id（PAT 为空）").
    return {
      userId: verified.userId,
      tokenId: verified.tokenId,
      clientId: null,
      scopes: verified.scopes,
    };
  }

  if (oauthEnabled && oauth !== undefined) {
    const verified = oauth.verifyAccessToken(token, { resource: `${oauth.publicBaseUrl}/mcp` });
    if (!verified.ok) {
      return null;
    }
    return {
      userId: verified.userId,
      tokenId: verified.tokenId,
      clientId: verified.clientId,
      scopes: verified.scopes,
    };
  }

  return null;
}

/**
 * Answers a rejected credential with the one 401 body and, while OAuth is on, the
 * RFC 9728 discovery challenge. The header value is assembled verbatim from the
 * injected base URL so a client can fetch the metadata AC-262 publishes.
 */
function rejectUnauthorized(res: Response, oauth: McpOauthSeam | undefined, oauthEnabled: boolean): void {
  if (oauthEnabled && oauth !== undefined) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${oauth.publicBaseUrl}${PROTECTED_RESOURCE_PATH}"`
    );
  }
  res.status(401).json(UNAUTHORIZED_BODY);
}

/**
 * Reads the principal a successful `createMcpAuthMiddleware` check attached, or
 * `null` when the request was not authenticated. Consumers: the transport's tool
 * dispatch (AC-245+), which needs the caller's `userId` for `ControlCaller`.
 */
export function readMcpPrincipal(res: Response): McpPrincipal | null {
  const principal = res.locals[MCP_PRINCIPAL_LOCAL] as McpPrincipal | undefined;
  return principal ?? null;
}
