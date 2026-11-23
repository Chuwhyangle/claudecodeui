/**
 * One staged measurement of this server's link to the model gateway.
 *
 * The stages come from SOCKET EVENTS rather than from fixed intervals, which is
 * what makes a reused connection report `null` for DNS/TCP/TLS honestly instead
 * of a fabricated zero, and what separates "the upload was slow" from "the relay
 * thought for a long time". The arithmetic that turns those marks into stages
 * lives in `api-latency-probe-stages.ts`; this file owns the socket orchestration
 * and the one promise a measurement settles.
 *
 * The request is issued with `node:http`/`node:https` directly — not through the
 * shared LLM client — because the measurement is the point: each socket event is
 * a mark, and a client that hides its transport would hide exactly the numbers
 * this page exists to show.
 *
 * Consumers: the routes (`POST /api/api-latency/probe`) and the module
 * composition root; nothing outside this module deep-imports it.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import type {
  ApiLatencyProbeResult,
  ResolvedApiLatencyGateway,
} from '@/shared/types.js';

import {
  buildRequestBody,
  createFirstTokenWatcher,
  toStageTimings,
  unwiredSample,
  type ApiLatencyProbeInput,
  type ProbeMarks,
} from './api-latency-probe-stages.js';
import {
  resolveApiLatencyGateway,
  stripContextSuffix,
  type ApiLatencyGatewayOptions,
} from './api-latency-settings.service.js';

/** A probe that never answers is a failed sample, not a hung request. */
const PROBE_TIMEOUT_MS = 90_000;

/**
 * What a probe answers when no credential is configured. It names the variables,
 * never a machine path: the sentence can be rendered anywhere, and the browser
 * may replace it with its own translated copy.
 */
const NO_CREDENTIAL_ERROR =
  'No gateway credential configured: set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY '
  + 'in the service environment or in the CLI settings file.';

/** Re-exported so the routes and criteria keep one import path for the probe's input. */
export type { ApiLatencyProbeInput };

/** The callable the routes use to take one measurement. */
export type ApiLatencyProbe = (input: ApiLatencyProbeInput) => Promise<ApiLatencyProbeResult>;

/**
 * The probe's seams.
 *
 * `resolveGateway` and `agent` are injected by criteria so a probe can run a real
 * measurement against a LOCAL http server instead of the deployment's gateway;
 * `gatewayOptions` carries the environment/home the default resolver reads.
 */
export type ApiLatencyProbeDeps = {
  resolveGateway?: (model?: string) => Promise<ResolvedApiLatencyGateway>;
  agent?: http.Agent | https.Agent;
  gatewayOptions?: ApiLatencyGatewayOptions;
};

/**
 * Build the probe over one resolved gateway at a time.
 *
 * The two agents are created once per probe instance and kept alive so
 * back-to-back samples report `reused` — the steady state of a real session.
 * Without that, every sample would pay TCP+TLS again and the page would report
 * the cost of a connection nobody makes.
 *
 * Consumers: `api-latency.module.ts` (production) and the probe criterion, which
 * passes its own resolver and a non-pooling agent.
 */
export function createApiLatencyProbe(deps: ApiLatencyProbeDeps = {}): ApiLatencyProbe {
  const resolveGateway = deps.resolveGateway
    ?? ((model?: string) => resolveApiLatencyGateway(model, deps.gatewayOptions));
  const plainAgent = deps.agent ?? new http.Agent({ keepAlive: true, maxSockets: 4 });
  const secureAgent = deps.agent ?? new https.Agent({ keepAlive: true, maxSockets: 4 });

  return async (input) => {
    const gateway = await resolveGateway(input.model);
    // Stripped here as well as in the resolver: a caller that injects its own
    // resolver must not be able to send a suffixed name, which the gateway
    // rejects with HTTP 400.
    const model = stripContextSuffix(gateway.model);
    const { body, bytes: requestBytes } = buildRequestBody(input, model);
    const id = randomUUID();
    const at = new Date().toISOString();
    const token = gateway.token;

    if (token === null) {
      return unwiredSample(id, at, input, model, requestBytes, NO_CREDENTIAL_ERROR);
    }

    let url: URL;
    try {
      url = new URL('/v1/messages', gateway.baseUrl);
    } catch {
      return unwiredSample(id, at, input, model, requestBytes, `Invalid gateway base URL: ${gateway.baseUrl}`);
    }

    return await new Promise<ApiLatencyProbeResult>((resolve) => {
      const startedAt = performance.now();
      const marks: ProbeMarks = {};
      const mark = (key: keyof ProbeMarks) => {
        if (marks[key] === undefined) marks[key] = Math.round(performance.now() - startedAt);
      };

      let transport: 'fresh' | 'reused' = 'fresh';
      let responseBytes = 0;
      let status: number | null = null;
      let settled = false;

      const finish = (error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          id,
          at,
          ok: error === null && status !== null && status >= 200 && status < 300,
          mode: input.mode,
          stream: input.stream,
          model,
          transport,
          status,
          requestBytes,
          responseBytes,
          timings: toStageTimings(marks),
          firstTokenMs: marks.firstToken ?? null,
          error,
        });
      };

      const timeout = setTimeout(() => {
        request.destroy(new Error(`Probe timed out after ${PROBE_TIMEOUT_MS} ms`));
      }, PROBE_TIMEOUT_MS);

      const onResponse = (response: http.IncomingMessage) => {
        mark('firstByte');
        status = response.statusCode ?? null;
        response.setEncoding('utf8');
        const watchToken = createFirstTokenWatcher(() => mark('firstToken'));
        response.on('data', (chunk: string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (input.stream) watchToken(chunk);
        });
        response.on('end', () => {
          mark('end');
          // A non-2xx answer keeps its timings: knowing the gateway took 30 s to
          // reject a request is itself the finding.
          finish(null);
        });
        response.on('error', (error) => finish(error.message));
      };

      const requestOptions: http.RequestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'content-length': requestBytes,
        },
      };
      // Split rather than picking the module by expression: the two overload sets
      // do not unify, and a criterion's local test gateway is plain http.
      const request = url.protocol === 'http:'
        ? http.request({ ...requestOptions, agent: plainAgent }, onResponse)
        : https.request({ ...requestOptions, agent: secureAgent }, onResponse);

      request.on('socket', (socket) => {
        mark('socket');
        if (!socket.connecting) {
          // A pooled socket: the DNS/TCP/TLS legs were paid by an earlier probe.
          transport = 'reused';
          return;
        }
        socket.once('lookup', () => mark('lookup'));
        socket.once('connect', () => mark('tcp'));
        socket.once('secureConnect', () => mark('tls'));
      });
      request.on('finish', () => mark('uploadDone'));
      request.on('error', (error) => {
        mark('end');
        finish(error.message);
      });
      request.end(body);
    });
  };
}
