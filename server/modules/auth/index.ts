// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';
// credentialVerifier: the assembled non-throwing credential check the OAuth
// consent page authenticates its browser user with. Consumers: server/index.ts,
// which injects it into the AC-268 OAuth mount.
export { credentialVerifier } from './auth.module.js';

// createCredentialVerifier: the non-throwing credential-check narrow port the
// OAuth consent page (AC-260, oauth module) authenticates its browser user
// with, and the contract its criterion exercises. Wraps authService.login.
export { createCredentialVerifier } from './credential-verifier.js';
export type {
  CredentialVerificationResult,
  CredentialVerifier,
} from './credential-verifier.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';

// createAuthRequestLogger: used by the server entrypoint, which mounts it on
// `/api/auth` ahead of the auth router so every request — including one the
// middleware refuses — leaves one secret-free line.
export { createAuthRequestLogger } from './auth-request-log.service.js';
