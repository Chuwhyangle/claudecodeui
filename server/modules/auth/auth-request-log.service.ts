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
 */

import type { Request, RequestHandler, Response } from 'express';

/** Where each finished request's line is written; `console.log` in production. */
type LogSink = (line: string) => void;

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
      log(
        `[AuthReq] ${printable(req.method, 8)} ${printable(req.originalUrl.split('?')[0], 100)} -> ${res.statusCode}`
        + ` reason=${refusalReason(res, bodyCode)} ${Date.now() - started}ms`
        + ` ip=${printable(header(req, 'cf-connecting-ip') ?? req.socket?.remoteAddress ?? '-', 45)}`
        + ` ua="${printable(header(req, 'user-agent') ?? '-', 60)}"`
      );
    });
    next();
  };
}
