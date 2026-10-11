import type { RequestHandler } from 'express';

/**
 * Marks every `/api/*` response uncacheable.
 *
 * WHY THIS MODULE. The static-assets module already owns the question "what may
 * a browser keep?", so the API's answer belongs beside the HTML/asset one rather
 * than inline in the entrypoint: this way the criterion in `tests/` mounts the
 * production middleware instead of a copy of it.
 *
 * WHY IT IS NEEDED. An `/api/*` response carries a credential-derived body and,
 * on a renewal, a terminal `X-Refreshed-Token` header. If a browser stores the
 * response it replays that header on the next load, and the client adopts the
 * replayed token — which was minted when the entry was stored, not when it was
 * replayed — rolling the session backwards until every refresh signs the user
 * out. `no-store` removes the response from the browser cache, so there is
 * nothing to replay; the client's monotonic accept (see the frontend's
 * `acceptRefreshedAuthToken`) is the second, independent guard.
 *
 * `Vary: Authorization` is appended, not set: it is the companion that tells any
 * intermediate cache the body depends on the caller's credential, so a cache that
 * ignored the credential could not serve one user a response meant for another.
 * `res.vary` appends, leaving any `Vary` the CORS layer already added intact.
 *
 * Mounted by the server entrypoint (`server/index.ts`) at the `/api` mount, ahead
 * of validation so refusals are uncacheable too. It only writes response headers,
 * so the streaming endpoints (SSE, TTS audio) mounted after it are never
 * buffered by it.
 */
export const apiNoStoreMiddleware: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.vary('Authorization');
  next();
};
