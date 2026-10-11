/**
 * One log line per `/api/auth/*` request, with every credential left out.
 *
 * The auth surface had no request log at all: a refused request left only the
 * client-visible 401, so from the server's own log "the server refused it" and
 * "the request never arrived" looked identical. This line says which — method,
 * path without the query, status, and the refusal reason (the `X-Auth-Error`
 * header, falling back to the response body's refusal code: the middleware's
 * top-level `code`, or the `error.code` of the server's AppError envelope), plus
 * the caller's address as Cloudflare reports it and the user agent.
 *
 * It never reads or prints: the `Authorization` bearer token, the `token` query
 * parameter (`authenticateToken`'s SSE fallback), passwords, or any request body.
 *
 * A login may additionally carry the client's own account of why it stopped
 * holding a token (`clientClock`: the client clock plus the lapse breadcrumb).
 * When it does, the SAME line gains `lapse=`, `exp=`, `clientNow=` and `skew=`
 * (client now − server now). Those four fields are the difference between the
 * next incident being readable from the log and the next debugger inferring the
 * cause from circumstantial evidence, which is what the 2026-10-11 report had to
 * do. The report is normalised and re-printed by the server, never echoed raw.
 */

import type { Request, RequestHandler, Response } from 'express';

/** Where each finished request's line is written; `console.log` in production. */
type LogSink = (line: string) => void;

/**
 * `res.locals` key the login route publishes the normalised client clock report
 * on. Defined here because this module owns the line format those fields appear
 * in; the route imports it rather than keeping a second copy of the contract.
 */
export const AUTH_CLIENT_CLOCK_LOCALS_KEY = 'authClientClockReport';

/** The lapse reasons the client may report. Anything else is dropped. */
const AUTH_LAPSE_REASONS = new Set(['server-401', 'server-expired', 'storage-empty', 'local-clock']);

/** The client's account of the lapse that preceded a login, as the client saw it. */
export type AuthClientClockLapse = {
  reason: string;
  exp: number | null;
  now: number;
  at: string;
};

/** The client clock report a login may carry, normalised. */
export type AuthClientClockReport = {
  now: number;
  lapse: AuthClientClockLapse | null;
};

/**
 * Normalises an untrusted `clientClock` body value, or null if unusable.
 *
 * The report comes from the network, so nothing of it is trusted or echoed: a
 * finite `now` is required, the lapse is kept only when its reason is one of the
 * four the client is allowed to report, and the timestamps are coerced to finite
 * numbers so a hostile body cannot smuggle text (or a credential) into the line.
 */
export function normalizeAuthClientClock(value: unknown): AuthClientClockReport | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as { now?: unknown; lapse?: unknown };
  const now = record.now;
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return null;
  }

  let lapse: AuthClientClockLapse | null = null;
  const rawLapse = record.lapse;
  if (typeof rawLapse === 'object' && rawLapse !== null) {
    const candidate = rawLapse as { reason?: unknown; exp?: unknown; now?: unknown; at?: unknown };
    if (typeof candidate.reason === 'string' && AUTH_LAPSE_REASONS.has(candidate.reason)) {
      lapse = {
        reason: candidate.reason,
        exp: typeof candidate.exp === 'number' && Number.isFinite(candidate.exp) ? candidate.exp : null,
        now: typeof candidate.now === 'number' && Number.isFinite(candidate.now) ? candidate.now : now,
        at: typeof candidate.at === 'string' ? printable(candidate.at, 40) : '-',
      };
    }
  }

  return { now, lapse };
}

/** The `lapse=/exp=/clientNow=/skew=` suffix for a line, or `''` when none was reported. */
function clientClockFields(report: AuthClientClockReport | undefined): string {
  if (!report) {
    return '';
  }
  const lapse = report.lapse;
  const skew = Math.round(report.now - Date.now());
  return ` lapse=${printable(lapse?.reason ?? '-', 20)}`
    + ` exp=${lapse !== null && lapse.exp !== null ? Math.round(lapse.exp) : '-'}`
    + ` clientNow=${Math.round(report.now)}`
    + ` skew=${skew}`;
}

/** Replaces anything that could break a log line (control characters, non-ASCII) and caps the length. */
function printable(value: unknown, max: number): string {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/** The first header value, or `undefined`. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The refusal reason: the `X-Auth-Error` header, else the body's `code`, else `-`. Never a credential. */
function refusalReason(res: Response, bodyCode: string | undefined): string {
  const fromHeader = res.getHeader('x-auth-error');
  const raw: string | number | undefined = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  return printable(raw ?? bodyCode ?? '-', 40);
}

/**
 * Creates the request logger. Mount it on `/api/auth` before the auth router; it
 * adds no behaviour of its own and never alters a response. Used by the server
 * entrypoint (`server/index.ts`) and by this module's criterion, which supplies
 * `log` to read the lines.
 */
export function createAuthRequestLogger(options: { log?: LogSink } = {}): RequestHandler {
  const log: LogSink = options.log ?? ((line) => console.log(line));

  return (req, res, next) => {
    const started = Date.now();
    let bodyCode: string | undefined;

    // Observe only the response body's refusal `code`: the auth middleware answers
    // `{ error, code }` while routes that fail through the server's AppError
    // handler answer `{ success:false, error:{ code, message } }`. register/login
    // also carry a token in the body, so nothing else from it is retained.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const record = body as { code?: unknown; error?: { code?: unknown } } | null;
      const code = record?.code ?? record?.error?.code;
      if (typeof code === 'string') {
        bodyCode = code;
      }
      return json(body);
    };

    res.on('finish', () => {
      const report = res.locals[AUTH_CLIENT_CLOCK_LOCALS_KEY] as AuthClientClockReport | undefined;
      log(
        `[AuthReq] ${printable(req.method, 8)} ${printable(req.originalUrl.split('?')[0], 100)} -> ${res.statusCode}`
        + ` reason=${refusalReason(res, bodyCode)} ${Date.now() - started}ms`
        + ` ip=${printable(header(req, 'cf-connecting-ip') ?? req.socket?.remoteAddress ?? '-', 45)}`
        + ` ua="${printable(header(req, 'user-agent') ?? '-', 60)}"`
        + clientClockFields(report)
      );
    });
    next();
  };
}
